import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DATA_DIR, SETTINGS_PATH } from "./config.ts";

/**
 * User settings, stored as JSON in the data folder and edited on the Settings screen.
 * Every value is validated here, both from the screen and from a hand-edited file.
 */

export type Browser = "chrome" | "chrome-beta" | "msedge";
export const BROWSERS: Record<Browser, string> = {
  chrome: "Google Chrome",
  "chrome-beta": "Google Chrome Beta",
  msedge: "Microsoft Edge",
};

export interface PhotoFolder {
  /** Absolute path of a folder with photos. Subfolders are included. */
  path: string;
  /** Subfolders to skip, relative to `path`, with "/" between levels (e.g. "2019/private"). */
  exclude: string[];
}

export interface Settings {
  folders: PhotoFolder[];
  /** Sites whose finds are never shown: your own websites and anything you always allow. */
  ignoredHosts: string[];
  /** When the night scan runs (local time, 24-hour clock). The end may be after midnight. */
  schedule: { enabled: boolean; start: string; end: string };
  /** Upper limit for the number of searches per night; the actual pace adapts below it. */
  maxPerNight: number;
  /** Finds below this similarity (0-100) with your original are not shown. */
  minSimilarity: number;
  browser: Browser;
  notifications: boolean;
  owner: { name: string; contact: string };
  /** Text of the claim letter, with {date}, {url}, {file}, {name} and {contact} as placeholders. */
  claimTemplate: string;
}

export const DEFAULT_CLAIM = `Date: {date}
Subject: Unauthorised use of my photograph

Dear Sir or Madam,

The page {url} shows a photograph that I made (original file: "{file}"). I am the author and copyright holder of this photograph, and I have not given permission or a licence for this use.

Please remove the photograph within 7 days, or contact me to license its use. I charge a licence fee for unauthorised use.

The information in this message is accurate, and I am the copyright holder of the work referred to.

Kind regards,

{name}
{contact}`;

export const DEFAULTS: Settings = {
  folders: [],
  ignoredHosts: [],
  schedule: { enabled: true, start: "01:15", end: "07:00" },
  maxPerNight: 500,
  minSimilarity: 75,
  browser: "chrome",
  notifications: true,
  owner: { name: "", contact: "" },
  claimTemplate: DEFAULT_CLAIM,
};

export const LIMITS = {
  maxPerNight: [10, 1000],
  minSimilarity: [50, 99],
} as const;

export class SettingsError extends Error {}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** "https://www.Example.com/page" → "example.com". Returns null if it is not a domain name. */
export function normalizeHost(input: unknown): string | null {
  const host = String(input ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/?#:].*$/, "")
    .replace(/^www\./, "")
    .replace(/\.$/, "");
  return HOST.test(host) ? host : null;
}

/** A find on `host` is hidden when `host` is in the list, or is a subdomain of an entry. */
export function isIgnoredHost(host: string | null | undefined, list: string[]): boolean {
  return !!host && list.some((d) => host === d || host.endsWith(`.${d}`));
}

export function normalizeFolderPath(input: unknown): string {
  let p = String(input ?? "").trim();
  if (!p) throw new SettingsError("Enter the full path of a folder.");
  if (p === "~" || p.startsWith("~/")) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new SettingsError(`Use a full path, starting with "/" (or "~/"): ${p}`);
  return path.resolve(p);
}

/** "2019\\private/" → "2019/private". Rejects ".." so an exclusion can never point outside the folder. */
export function normalizeExclude(input: unknown): string | null {
  const parts = String(input ?? "")
    .replace(/\\/g, "/")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((s) => s === "." || s === "..")) throw new SettingsError(`Not a subfolder: ${String(input)}`);
  return parts.join("/");
}

const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function int(value: unknown, [min, max]: readonly [number, number], label: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new SettingsError(`${label} must be a whole number from ${min} to ${max}.`);
  return n;
}

function text(value: unknown, max: number, label: string): string {
  const s = String(value ?? "");
  if (s.length > max) throw new SettingsError(`${label} is too long (at most ${max} characters).`);
  return s;
}

/** Merges `patch` over `base` and validates the result. Unknown keys are ignored. */
export function validate(patch: unknown, base: Settings = DEFAULTS): Settings {
  if (!isObject(patch)) throw new SettingsError("Settings must be an object.");
  const p = patch;
  const s: Settings = structuredClone(base);

  if ("folders" in p) {
    if (!Array.isArray(p.folders)) throw new SettingsError("folders must be a list.");
    s.folders = p.folders.map((f): PhotoFolder => {
      const raw: Record<string, unknown> = isObject(f) ? f : { path: f };
      const exclude: unknown[] = Array.isArray(raw.exclude) ? raw.exclude : [];
      return {
        path: normalizeFolderPath(raw.path),
        exclude: [...new Set(exclude.map(normalizeExclude).filter((e): e is string => !!e))],
      };
    });
    for (const [i, a] of s.folders.entries()) {
      for (const b of s.folders.slice(i + 1)) {
        if (a.path === b.path) throw new SettingsError(`This folder is already in the list: ${a.path}`);
        if (inside(a.path, b.path) || inside(b.path, a.path))
          throw new SettingsError(`One folder is inside the other: ${a.path} and ${b.path}. Keep the outer one and skip subfolders instead.`);
      }
    }
  }

  if ("ignoredHosts" in p) {
    if (!Array.isArray(p.ignoredHosts)) throw new SettingsError("ignoredHosts must be a list.");
    const hosts: string[] = [];
    for (const h of p.ignoredHosts) {
      const clean = normalizeHost(h);
      if (!clean) throw new SettingsError(`Not a website address: ${String(h)}`);
      if (!hosts.includes(clean)) hosts.push(clean);
    }
    s.ignoredHosts = hosts;
  }

  if ("schedule" in p) {
    if (!isObject(p.schedule)) throw new SettingsError("schedule must be an object.");
    const sc = { ...s.schedule, ...p.schedule };
    if (typeof sc.enabled !== "boolean") throw new SettingsError("schedule.enabled must be true or false.");
    for (const k of ["start", "end"] as const)
      if (typeof sc[k] !== "string" || !TIME.test(sc[k])) throw new SettingsError(`Use a time like 01:15 for the ${k} of the night scan.`);
    if (sc.start === sc.end) throw new SettingsError("The night scan needs an end time that differs from the start time.");
    s.schedule = { enabled: sc.enabled, start: sc.start, end: sc.end };
  }

  if ("maxPerNight" in p) s.maxPerNight = int(p.maxPerNight, LIMITS.maxPerNight, "Photos per night");
  if ("minSimilarity" in p) s.minSimilarity = int(p.minSimilarity, LIMITS.minSimilarity, "Minimum similarity");

  if ("browser" in p) {
    if (!(String(p.browser) in BROWSERS)) throw new SettingsError(`Browser must be one of: ${Object.keys(BROWSERS).join(", ")}.`);
    s.browser = p.browser as Browser;
  }

  if ("notifications" in p) {
    if (typeof p.notifications !== "boolean") throw new SettingsError("notifications must be true or false.");
    s.notifications = p.notifications;
  }

  if ("owner" in p) {
    if (!isObject(p.owner)) throw new SettingsError("owner must be an object.");
    const o = { ...s.owner, ...p.owner };
    s.owner = { name: text(o.name, 200, "Your name").trim(), contact: text(o.contact, 300, "Contact details").trim() };
  }

  if ("claimTemplate" in p) {
    const t = text(p.claimTemplate, 10_000, "The claim letter");
    s.claimTemplate = t.trim() ? t : DEFAULT_CLAIM;
  }

  return s;
}

let cache: { mtimeMs: number; settings: Settings } | null = null;

/** Current settings: the file in the data folder over the defaults. */
export function loadSettings(): Settings {
  let st: fs.Stats;
  try {
    st = fs.statSync(SETTINGS_PATH);
  } catch {
    return structuredClone(DEFAULTS);
  }
  if (cache && cache.mtimeMs === st.mtimeMs) return structuredClone(cache.settings);
  let json: unknown;
  try {
    json = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch (e) {
    throw new SettingsError(`${SETTINGS_PATH} is not valid JSON: ${(e as Error).message}`);
  }
  const settings = validate(json, DEFAULTS);
  cache = { mtimeMs: st.mtimeMs, settings };
  return structuredClone(settings);
}

/** Can this folder be read right now? Network drives can hang, hence the time limit. */
export async function folderReadable(dir: string, timeoutMs = 8_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs)));
  const read = fs.promises.readdir(dir).then(
    () => true,
    () => false
  );
  try {
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates `patch` over the current settings and writes them. Folders that are new in
 * this change must exist; folders that were already there may be offline for a while.
 */
export async function saveSettings(patch: unknown): Promise<Settings> {
  const current = loadSettings();
  const next = validate(patch, current);
  const known = new Set(current.folders.map((f) => f.path));
  for (const f of next.folders) {
    if (known.has(f.path)) continue;
    const st = await fs.promises.stat(f.path).catch(() => null);
    if (!st?.isDirectory()) throw new SettingsError(`Folder not found: ${f.path}`);
    if (!(await folderReadable(f.path))) throw new SettingsError(`Bootleg may not read this folder: ${f.path}`);
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${SETTINGS_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n");
  fs.renameSync(tmp, SETTINGS_PATH);
  cache = null;
  return next;
}
