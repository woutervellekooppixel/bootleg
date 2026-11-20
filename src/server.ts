import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import sharp from "sharp";

import { ALLOWED_HOSTS, CACHE_DIR, PORT, PROJECT_DIR, SETTINGS_PATH } from "./config.ts";
import { data, foldersInfo } from "./data.ts";
import { db, nowIso, STATUSES, type Status } from "./db.ts";
import { jobState, lastRun, startJob, startScheduler, stopJob } from "./jobs.ts";
import { BROWSERS, DEFAULT_CLAIM, LIMITS, loadSettings, normalizeHost, saveSettings, SettingsError } from "./settings.ts";

const UI_PATH = path.join(PROJECT_DIR, "ui", "index.html");
const log = (s: string) => console.log(`${new Date().toLocaleTimeString()} ${s}`);

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------- safety ----------
// The app has no password: it only listens on this machine. These checks keep other
// websites you visit from reading it (DNS rebinding) or changing it (cross-site requests).

const HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", ...ALLOWED_HOSTS]);
const hostName = (h: string) => h.toLowerCase().replace(/:\d+$/, "");

function hostAllowed(req: http.IncomingMessage): boolean {
  return HOSTS.has(hostName(req.headers.host ?? ""));
}

function writeAllowed(req: http.IncomingMessage): boolean {
  if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // not a browser (curl, scripts on this machine)
  try {
    return HOSTS.has(hostName(new URL(origin).host));
  } catch {
    return false;
  }
}

// ---------- helpers ----------

async function readJson(req: http.IncomingMessage): Promise<any> {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new SettingsError("Request too large.");
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    throw new SettingsError("Not valid JSON.");
  }
}

function send(res: http.ServerResponse, status: number, body: string | Buffer, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": type.startsWith("image/") ? "private, max-age=86400" : "no-store",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cross-origin-resource-policy": "same-origin",
  });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body));

async function photoThumb(id: number, w: number): Promise<Buffer | null> {
  const row = db.prepare("SELECT path, mtime FROM photos WHERE id = ?").get(id) as { path: string; mtime: number } | undefined;
  if (!row) return null;
  const cached = path.join(CACHE_DIR, `${id}-${row.mtime}-${w}.jpg`);
  if (fs.existsSync(cached)) return fs.readFileSync(cached);
  const buf = await sharp(row.path).rotate().resize(w, w, { fit: "inside", withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  fs.writeFileSync(cached, buf);
  return buf;
}

function findThumb(id: number): { type: string; body: Buffer } | null {
  const row = db.prepare("SELECT thumb FROM finds WHERE id = ?").get(id) as { thumb: string | null } | undefined;
  if (!row?.thumb?.startsWith("data:image/")) return null;
  const type = row.thumb.slice(5, row.thumb.indexOf(";")) || "image/jpeg";
  if (!/^image\/(jpeg|png|webp|gif|avif)$/.test(type)) return null;
  return { type, body: Buffer.from(row.thumb.slice(row.thumb.indexOf(",") + 1), "base64") };
}

function reveal(file: string): void {
  const done = () => {};
  if (process.platform === "darwin") execFile("open", ["-R", file], done);
  else if (process.platform === "win32") execFile("explorer.exe", [`/select,${file}`], done);
  else execFile("xdg-open", [path.dirname(file)], done);
}

/** macOS: the system folder picker, on this Mac. */
function pickFolder(): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "osascript",
      ["-e", "activate", "-e", 'POSIX path of (choose folder with prompt "Choose a folder with photos for Bootleg")'],
      { timeout: 10 * 60_000 },
      (err, stdout) => {
        if (err) return /-128|User canceled/i.test(String(err.message) + stdout) ? resolve(null) : reject(err);
        resolve(stdout.trim().replace(/\/$/, "") || null);
      }
    );
  });
}

// Read the folders again shortly after they change in Settings (once no other job runs).
let indexWanted = false;
setInterval(() => {
  if (!indexWanted || jobState()) return;
  indexWanted = false;
  startJob("index", { log });
}, 3_000);

// ---------- routes ----------

const server = http.createServer(async (req, res) => {
  try {
    if (!hostAllowed(req)) return send(res, 403, "Unknown host. Add it to BOOTLEG_ALLOWED_HOSTS to allow it.", "text/plain");
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
    const parts = url.pathname.split("/").filter(Boolean);
    const method = req.method ?? "GET";
    if (method !== "GET" && method !== "HEAD" && !writeAllowed(req)) return json(res, 403, { error: "Refused: not from the Bootleg app." });

    if (method === "GET" && url.pathname === "/") return send(res, 200, fs.readFileSync(UI_PATH), "text/html; charset=utf-8");

    if (method === "GET" && url.pathname === "/api/data") return json(res, 200, data());

    if (method === "GET" && url.pathname === "/api/settings")
      return json(res, 200, {
        settings: loadSettings(),
        meta: { file: SETTINGS_PATH, platform: process.platform, browsers: BROWSERS, limits: LIMITS, defaultClaim: DEFAULT_CLAIM },
      });

    if (method === "PUT" && url.pathname === "/api/settings") {
      const before = JSON.stringify(loadSettings().folders);
      const settings = await saveSettings(await readJson(req));
      if (JSON.stringify(settings.folders) !== before) indexWanted = true;
      return json(res, 200, { settings });
    }

    if (method === "GET" && url.pathname === "/api/folders") return json(res, 200, await foldersInfo());

    if (method === "POST" && url.pathname === "/api/folders/pick") {
      if (process.platform !== "darwin") return json(res, 400, { error: "Only on macOS: type the path instead." });
      return json(res, 200, { path: await pickFolder() });
    }

    if (method === "GET" && url.pathname === "/api/job") return json(res, 200, { job: jobState(), lastRun: lastRun() });

    if (method === "POST" && url.pathname === "/api/job") {
      const body = await readJson(req);
      if (body.kind !== "index" && body.kind !== "scan") return json(res, 400, { error: "Unknown job." });
      const count = Math.max(1, Math.min(1000, Number(body.count) || 10));
      const run = startJob(body.kind, { count, log });
      if (!run) return json(res, 409, { error: "Bootleg is busy. Wait until it is done, or stop it first." });
      return json(res, 202, { job: jobState() });
    }

    if (method === "POST" && url.pathname === "/api/job/stop") return json(res, 200, { stopping: stopJob() });

    if (method === "POST" && parts[0] === "api" && parts[1] === "find" && parts[3] === "status") {
      const { status } = await readJson(req);
      if (!STATUSES.includes(status as Status)) return json(res, 400, { error: "Unknown status." });
      db.prepare("UPDATE finds SET status = ?, status_at = ? WHERE id = ?").run(status, nowIso(), Number(parts[2]));
      return json(res, 200, { ok: true });
    }

    if (method === "POST" && url.pathname === "/api/ignore") {
      const host = normalizeHost((await readJson(req)).host);
      if (!host) return json(res, 400, { error: "Not a website address." });
      const current = loadSettings().ignoredHosts;
      if (!current.includes(host)) await saveSettings({ ignoredHosts: [...current, host] });
      return json(res, 200, { ok: true, host });
    }

    if (method === "POST" && parts[0] === "api" && parts[1] === "reveal") {
      const row = db.prepare("SELECT path FROM photos WHERE id = ?").get(Number(parts[2])) as { path: string } | undefined;
      if (row) reveal(row.path);
      return json(res, 200, { ok: !!row });
    }

    if (method === "GET" && parts[0] === "img" && parts[1] === "photo") {
      const w = Math.min(1600, Math.max(100, Number(url.searchParams.get("w") ?? 600)));
      const buf = await photoThumb(Number(parts[2]), w).catch(() => null);
      return buf ? send(res, 200, buf, "image/jpeg") : json(res, 404, {});
    }

    if (method === "GET" && parts[0] === "img" && parts[1] === "find") {
      const t = findThumb(Number(parts[2]));
      return t ? send(res, 200, t.body, t.type) : json(res, 404, {});
    }

    json(res, 404, { error: "Not found." });
  } catch (e) {
    const status = e instanceof SettingsError ? 400 : 500;
    if (status === 500) console.error(e);
    json(res, status, { error: String((e as Error).message ?? e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  log(`Bootleg: http://localhost:${PORT}`);
  const s = loadSettings();
  if (!s.folders.length) log("No photo folders yet: open the app and add them in Settings.");
  else log(`Night run ${s.schedule.enabled ? `daily from ${s.schedule.start} to ${s.schedule.end}` : "is off"}.`);
  startScheduler(log);
});
