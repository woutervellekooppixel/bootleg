import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { tempDir, useTempDataDir } from "./helpers.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = useTempDataDir();
const port: number = await new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => {
    const p = (s.address() as net.AddressInfo).port;
    s.close(() => resolve(p));
  });
});

const app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  cwd: root,
  env: { ...process.env, PHOTOWATCH_DATA_DIR: dataDir, PHOTOWATCH_PORT: String(port) },
  stdio: ["ignore", "pipe", "inherit"],
});

before(async () => {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the app did not start")), 20_000);
    app.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes(`http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
});
after(() => {
  app.kill();
});

function request(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path: url, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => {
        let json: any = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode!, json });
      });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

const JSON_TYPE = { "content-type": "application/json" };

test("serves the app and its data", async () => {
  const r = await request("GET", "/api/data");
  assert.equal(r.status, 200);
  assert.equal(r.json.configured, false);
  assert.deepEqual(r.json.finds, []);
  assert.equal((await request("GET", "/")).status, 200);
});

test("refuses other host names (DNS rebinding)", async () => {
  assert.equal((await request("GET", "/api/data", { host: "evil.example" })).status, 403);
});

test("refuses changes from other websites", async () => {
  const change = { maxPerNight: 100 };
  assert.equal((await request("PUT", "/api/settings", {}, change)).status, 403, "no JSON content type (a simple cross-site request)");
  assert.equal((await request("PUT", "/api/settings", { ...JSON_TYPE, origin: "https://evil.example" }, change)).status, 403);
  const ok = await request("PUT", "/api/settings", { ...JSON_TYPE, origin: `http://localhost:${port}` }, change);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.settings.maxPerNight, 100);
});

test("settings: errors come back as a message", async () => {
  const r = await request("PUT", "/api/settings", JSON_TYPE, { folders: ["/this/folder/does/not/exist"] });
  assert.equal(r.status, 400);
  assert.match(r.json.error, /Folder not found/);
});

test("adding a folder starts reading it", async () => {
  const lib = tempDir();
  const r = await request("PUT", "/api/settings", JSON_TYPE, { folders: [lib] });
  assert.equal(r.status, 200);
  const folders = await request("GET", "/api/folders");
  assert.equal(folders.json[0].path, lib);
  assert.equal(folders.json[0].available, true);
  // The index job starts a few seconds after the change.
  let last = null;
  for (let i = 0; i < 40 && !last; i++) {
    await new Promise((r) => setTimeout(r, 250));
    last = (await request("GET", "/api/job")).json.lastRun;
  }
  assert.equal(last?.kind, "index");
  assert.equal(last?.photos, 0);
});
