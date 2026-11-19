import fs from "node:fs/promises";
import path from "node:path";

import { RECENT_YEARS } from "./config.ts";
import { budgetState } from "./budget.ts";
import { db, getState } from "./db.ts";
import { shootOf } from "./indexer.ts";
import { jobState, lastRun } from "./jobs.ts";
import { nightWindow } from "./schedule.ts";
import { folderReadable, isIgnoredHost, loadSettings } from "./settings.ts";

/** Everything the interface shows: finds (without ignored sites and non-matches) and progress. */
export function data() {
  const s = loadSettings();
  const recentFrom = new Date().getFullYear() - (RECENT_YEARS - 1);
  const rows = db
    .prepare(
      `SELECT f.id, f.photo_id, f.url, f.host, f.title, f.similarity, f.first_seen, f.last_seen, f.status, f.status_at,
              p.root, p.rel,
              (SELECT COUNT(*) FROM photos m WHERE m.rep_id = p.id) AS series
       FROM finds f JOIN photos p ON p.id = f.photo_id
       WHERE f.similarity >= ?
       ORDER BY f.first_seen DESC`
    )
    .all(s.minSimilarity) as Record<string, any>[];

  const finds = rows
    .filter((f) => !isIgnoredHost(f.host, s.ignoredHosts))
    .map(({ root, rel, ...f }) => ({
      ...f,
      path: rel as string,
      shoot: shootOf(rel) || path.basename(root),
      file: path.posix.basename(rel),
    }));

  const stats = db
    .prepare(
      `SELECT COUNT(*) AS photos,
              SUM(rep_id IS NULL) AS reps,
              SUM(rep_id IS NULL AND last_scanned_at IS NOT NULL) AS scanned,
              SUM(rep_id IS NULL AND year >= ?) AS recentReps,
              SUM(rep_id IS NULL AND year >= ? AND last_scanned_at IS NOT NULL) AS recentScanned,
              SUM(phash IS NULL AND hash_error IS NULL) AS unhashed
       FROM photos WHERE missing = 0`
    )
    .get(recentFrom, recentFrom) as Record<string, number>;
  const lastScan = db.prepare("SELECT MAX(at) AS at FROM scans").get() as { at: string | null };
  const last24h = db
    .prepare("SELECT COUNT(*) AS n FROM scans WHERE at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours') AND status = 'ok'")
    .get() as { n: number };
  const perYear = db
    .prepare(
      `SELECT year, COUNT(*) AS reps, SUM(last_scanned_at IS NOT NULL) AS scanned
       FROM photos WHERE rep_id IS NULL AND missing = 0 AND year IS NOT NULL GROUP BY year ORDER BY year DESC`
    )
    .all();

  const w = nightWindow(new Date(), s.schedule.start, s.schedule.end);
  return {
    configured: s.folders.length > 0,
    platform: process.platform,
    stats: { ...stats, lastScanAt: lastScan.at, last24h: last24h.n, recentFrom },
    captchaUntil: getState("captcha_until"),
    budget: budgetState(),
    night: { ...s.schedule, nextStart: w.start.toISOString(), inside: w.inside },
    job: jobState(),
    lastRun: lastRun(),
    perYear,
    finds,
  };
}

/**
 * Per photo folder: can it be read, how many photos, and its subfolders with their counts,
 * for the Settings screen. Skipped subfolders have no photos in the index (they count as gone).
 */
export async function foldersInfo() {
  const s = loadSettings();
  const out = [];
  for (const f of s.folders) {
    const available = await folderReadable(f.path, 4_000);
    const counts = db
      .prepare(
        `SELECT CASE WHEN instr(rel, '/') > 0 THEN substr(rel, 1, instr(rel, '/') - 1) ELSE '' END AS top,
                COUNT(*) AS photos, SUM(rep_id IS NULL) AS reps, SUM(rep_id IS NULL AND last_scanned_at IS NOT NULL) AS scanned
         FROM photos WHERE root = ? AND missing = 0 GROUP BY top`
      )
      .all(f.path) as { top: string; photos: number; reps: number; scanned: number }[];
    const byTop = new Map(counts.map((c) => [c.top, c]));
    let names: string[] = [];
    if (available) {
      const entries = await fs.readdir(f.path, { withFileTypes: true }).catch(() => []);
      names = entries.filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
    } else names = counts.map((c) => c.top).filter(Boolean);
    for (const e of f.exclude) if (!e.includes("/") && !names.includes(e)) names.push(e);
    // Year folders (and other names starting with a digit) newest first, then the rest A-Z.
    const dated = (n: string) => /^\d/.test(n);
    names.sort((a, b) =>
      dated(a) !== dated(b) ? (dated(a) ? -1 : 1) : dated(a) ? b.localeCompare(a, undefined, { numeric: true }) : a.localeCompare(b)
    );
    const total = counts.reduce((a, c) => ({ photos: a.photos + c.photos, reps: a.reps + c.reps, scanned: a.scanned + c.scanned }), { photos: 0, reps: 0, scanned: 0 });
    out.push({
      path: f.path,
      name: path.basename(f.path),
      available,
      ...total,
      loose: byTop.get("")?.photos ?? 0,
      subfolders: names.map((name) => ({
        name,
        excluded: f.exclude.includes(name),
        photos: byTop.get(name)?.photos ?? 0,
        reps: byTop.get(name)?.reps ?? 0,
        scanned: byTop.get(name)?.scanned ?? 0,
      })),
      /** Skipped folders deeper down, e.g. "2019/private". */
      deeper: f.exclude.filter((e) => e.includes("/")),
    });
  }
  return out;
}
