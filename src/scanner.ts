import fs from "node:fs/promises";

import { CAPTCHA_BACKOFF_HOURS, DELAY_MS, KEEP_THUMB_FROM } from "./config.ts";
import { budgetAfterCaptcha } from "./budget.ts";
import { db, getState, nowIso, setState } from "./db.ts";
import type { StepContext } from "./indexer.ts";
import { CaptchaError, Lens } from "./lens.ts";
import { planNight } from "./schedule.ts";
import { folderReadable, isIgnoredHost, loadSettings } from "./settings.ts";
import { bestSimilarity } from "./similarity.ts";

interface QueueItem {
  id: number;
  path: string;
  root: string;
  rel: string;
  rescan?: boolean;
}

const likePrefix = (s: string) => `${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

/** By hand: every representative under a folder (a full path, or a path inside a photo folder), whenever it was last searched. */
export function pickFolder(prefix: string, limit: number): QueueItem[] {
  return db
    .prepare(
      `SELECT id, path, root, rel FROM photos
       WHERE rep_id IS NULL AND missing = 0 AND phash IS NOT NULL AND (path LIKE ? ESCAPE '\\' OR rel LIKE ? ESCAPE '\\')
       ORDER BY path LIMIT ?`
    )
    .all(likePrefix(prefix), likePrefix(prefix), limit) as unknown as QueueItem[];
}

/**
 * Tonight's queue, see planNight in schedule.ts: newest shoot first, young photos searched
 * again more often. Only representatives of a series, only photos with a fingerprint, and
 * only from folders that can be read right now.
 */
export function pickQueue(limit: number, roots?: Set<string>): (QueueItem & { shot: number; rescan: boolean })[] {
  const rows = (
    db
      .prepare(
        "SELECT id, path, root, rel, mtime, taken, last_scanned_at FROM photos WHERE rep_id IS NULL AND missing = 0 AND phash IS NOT NULL"
      )
      .all() as { id: number; path: string; root: string; rel: string; mtime: number; taken: number | null; last_scanned_at: string | null }[]
  ).filter((r) => !roots || roots.has(r.root));
  return planNight(rows, limit);
}

export const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
};

export interface ScanSummary {
  scanned: number;
  errors: number;
  newFinds: number;
  stoppedBy: "budget" | "captcha" | "backoff" | "deadline" | "empty" | "stopped" | "unavailable";
}

const sleep = async (ms: number, shouldStop?: () => boolean) => {
  const until = Date.now() + ms;
  while (Date.now() < until && !shouldStop?.()) await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
};

export async function runScan(
  opts: StepContext & {
    budget: number;
    /** Only this folder, regardless of the schedule. */
    folder?: string;
    /** The night run: a captcha lowers the pace for the coming nights. */
    adaptive?: boolean;
  }
): Promise<ScanSummary> {
  const log = opts.log ?? (() => {});
  const backoffUntil = getState("captcha_until");
  if (backoffUntil && new Date(backoffUntil) > new Date()) {
    log(`Paused after a captcha until ${new Date(backoffUntil).toLocaleString()}; not searching.`);
    return { scanned: 0, errors: 0, newFinds: 0, stoppedBy: "backoff" };
  }

  const settings = loadSettings();
  const roots = new Set<string>();
  for (const f of settings.folders) if (await folderReadable(f.path)) roots.add(f.path);
  if (settings.folders.length && !roots.size) {
    log("None of the photo folders can be read right now.");
    return { scanned: 0, errors: 0, newFinds: 0, stoppedBy: "unavailable" };
  }

  const queue: QueueItem[] = opts.folder ? pickFolder(opts.folder, opts.budget) : pickQueue(opts.budget, roots);
  if (!queue.length) return { scanned: 0, errors: 0, newFinds: 0, stoppedBy: "empty" };
  if (!opts.folder) {
    const rescans = queue.filter((p) => p.rescan).length;
    log(`Queue: ${queue.length - rescans} never searched, ${rescans} again (newest first)`);
  }

  const insertScan = db.prepare("INSERT INTO scans(photo_id, at, status, results, error) VALUES(?, ?, ?, ?, ?)");
  const markScanned = db.prepare("UPDATE photos SET last_scanned_at = ?, scan_count = scan_count + 1 WHERE id = ?");
  const upsertFind = db.prepare(`
    INSERT INTO finds(photo_id, url, host, title, thumb, similarity, first_seen, last_seen)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(photo_id, url) DO UPDATE SET last_seen = excluded.last_seen
    RETURNING first_seen = last_seen AS is_new
  `);

  const lens = new Lens(settings.browser);
  await lens.open();
  const summary: ScanSummary = { scanned: 0, errors: 0, newFinds: 0, stoppedBy: "budget" };
  const offline = new Set<string>();
  try {
    for (const [i, photo] of queue.entries()) {
      if (opts.shouldStop?.()) {
        summary.stoppedBy = "stopped";
        break;
      }
      if (opts.deadline && Date.now() > opts.deadline) {
        summary.stoppedBy = "deadline";
        break;
      }
      if (offline.has(photo.root)) continue;
      opts.progress?.(i, queue.length, photo.rel);
      const at = nowIso();
      try {
        const hits = await lens.search(photo.path);
        const bytes = hits.length ? await fs.readFile(photo.path) : null;
        for (const h of hits) {
          const sim = await bestSimilarity(bytes!, h.thumb).catch(() => null);
          // Clearly different images (a logo that also appears in your photo, say) are
          // remembered, but without their thumbnail; they never show up.
          const thumb = sim === null || sim >= KEEP_THUMB_FROM ? h.thumb : null;
          const host = hostOf(h.url);
          const row = upsertFind.get(photo.id, h.url, host, h.title, thumb, sim, at, at) as { is_new: number };
          if (row.is_new && sim !== null && sim >= settings.minSimilarity && !isIgnoredHost(host, settings.ignoredHosts)) summary.newFinds++;
        }
        insertScan.run(photo.id, at, "ok", hits.length, null);
        markScanned.run(at, photo.id);
        summary.scanned++;
        log(`[${i + 1}/${queue.length}] ${photo.rel} → ${hits.length}`);
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        if (e instanceof CaptchaError) {
          insertScan.run(photo.id, at, "captcha", 0, null);
          const until = new Date(Date.now() + CAPTCHA_BACKOFF_HOURS * 3_600_000).toISOString();
          setState("captcha_until", until);
          // Manual scans leave the night pace alone.
          const note = opts.adaptive ? `; from now on ${budgetAfterCaptcha()} per night` : "";
          log(`Captcha after ${summary.scanned} photos; paused until ${new Date(until).toLocaleString()}${note}.`);
          summary.stoppedBy = "captcha";
          break;
        }
        // The browser window was closed: stop, without marking the photo as searched.
        if (/has been closed|Target closed|browser has disconnected/i.test(msg)) throw e;
        // The drive went away: skip its photos for now, without marking them as searched.
        if (!(await folderReadable(photo.root))) {
          offline.add(photo.root);
          log(`Not available any more: ${photo.root}`);
          continue;
        }
        insertScan.run(photo.id, at, "error", 0, msg.slice(0, 300));
        summary.errors++;
        log(`[${i + 1}/${queue.length}] ${photo.rel} → error: ${msg.split("\n")[0]}`);
        // A photo that keeps failing should not stay at the front of the queue forever.
        markScanned.run(at, photo.id);
      }
      const [min, max] = DELAY_MS;
      if (i < queue.length - 1) await sleep(min + Math.random() * (max - min), opts.shouldStop);
    }
  } finally {
    await lens.close();
  }
  return summary;
}
