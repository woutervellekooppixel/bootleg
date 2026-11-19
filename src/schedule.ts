import { RESCAN_SCHEDULE, RESCAN_SHARE } from "./config.ts";

const DAY = 86_400_000;

/** A date in a folder or file name: 2026-10-17_…, 20261017-…, IMG_20261017_… or 2026/10/17/… */
const DATE_IN_PATH = /(?:^|[/_ -])((?:19|20)\d{2})[-/]?(0[1-9]|1[0-2])[-/]?(0[1-9]|[12]\d|3[01])(?=[_ .\/-])/;

/** The year of a top-level year folder (`2025/…`), if the library is organised that way. */
export function folderYear(rel: string): number | null {
  const m = /^((?:19|20)\d{2})\//.exec(rel);
  return m ? Number(m[1]) : null;
}

export interface Dated {
  /** Path inside the photo folder, "/" between levels. */
  rel: string;
  /** EXIF date taken (ms), if known. */
  taken: number | null;
  /** File modification time (ms). */
  mtime: number;
}

/**
 * Shoot date (ms): a date in the path, else the EXIF date taken, else the file date. When the
 * library has year folders, a date must fit that year (±1), and the file date is capped at the
 * end of it, so an old folder that was copied recently does not count as new.
 */
export function shotTime(p: Dated, now = Date.now()): number {
  const fy = folderYear(p.rel);
  const plausible = (t: number) =>
    t <= now && t >= Date.UTC(1990, 0, 1) && (fy === null || Math.abs(new Date(t).getUTCFullYear() - fy) <= 1);
  const m = DATE_IN_PATH.exec(p.rel);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
    if (plausible(t)) return t;
  }
  if (p.taken != null && plausible(p.taken)) return p.taken;
  const endOfYear = fy ? Date.UTC(fy + 1, 0, 1) - 1 : Infinity;
  return Math.min(p.mtime, endOfYear, now);
}

/** The year a photo is counted under in the progress numbers. */
export function yearOf(p: Dated): number {
  return folderYear(p.rel) ?? new Date(shotTime(p)).getUTCFullYear();
}

/** How often a photo of this age is searched again (see RESCAN_SCHEDULE). */
export function rescanIntervalDays(ageDays: number): number {
  for (const [maxAge, interval] of RESCAN_SCHEDULE) if (ageDays < maxAge) return interval;
  return RESCAN_SCHEDULE[RESCAN_SCHEDULE.length - 1][1];
}

/**
 * Due for a rescan? Half a day of slack, so "every week" does not slide to day 8 because
 * last week's run started a few minutes later.
 */
export function isDue(shot: number, lastScannedAt: string, now = Date.now()): boolean {
  const age = (now - shot) / DAY;
  const since = (now - Date.parse(lastScannedAt)) / DAY;
  return since >= rescanIntervalDays(age) - 0.5;
}

export interface Candidate extends Dated {
  path: string;
  last_scanned_at: string | null;
}

/**
 * Tonight's queue: everything that is due (never searched, or due for a rescan), newest shoot
 * first. Rescans get at most RESCAN_SHARE of the budget while there are photos that were never
 * searched; budget that is left over goes to the remaining rescans.
 */
export function planNight<T extends Candidate>(rows: T[], limit: number, now = Date.now()): (T & { shot: number; rescan: boolean })[] {
  const todo: (T & { shot: number; rescan: boolean })[] = [];
  let unscanned = 0;
  for (const r of rows) {
    const shot = shotTime(r, now);
    if (!r.last_scanned_at) {
      todo.push({ ...r, shot, rescan: false });
      unscanned++;
    } else if (isDue(shot, r.last_scanned_at, now)) todo.push({ ...r, shot, rescan: true });
  }
  todo.sort((a, b) => b.shot - a.shot || (a.path < b.path ? -1 : 1));

  const maxRescans = unscanned > 0 ? Math.ceil(limit * RESCAN_SHARE) : limit;
  const out: typeof todo = [];
  const held: typeof todo = [];
  let rescans = 0;
  for (const t of todo) {
    if (out.length >= limit) break;
    if (!t.rescan) out.push(t);
    else if (rescans < maxRescans) {
      out.push(t);
      rescans++;
    } else held.push(t);
  }
  for (const t of held) {
    if (out.length >= limit) break;
    out.push(t);
  }
  return out;
}

/** "01:15" → [1, 15] */
const hm = (s: string) => s.split(":").map(Number) as [number, number];

/**
 * The night window (local time) that `now` falls in, or otherwise the next one. The end may be
 * after midnight (23:00-06:00). `key` names the night by the date it started.
 */
export function nightWindow(now: Date, start: string, end: string): { start: Date; end: Date; inside: boolean; key: string } {
  const [sh, sm] = hm(start);
  const [eh, em] = hm(end);
  const wraps = eh * 60 + em <= sh * 60 + sm;
  for (const offset of [-1, 0, 1]) {
    const ws = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset, sh, sm, 0, 0);
    const we = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset + (wraps ? 1 : 0), eh, em, 0, 0);
    if (now < we) {
      const key = `${ws.getFullYear()}-${String(ws.getMonth() + 1).padStart(2, "0")}-${String(ws.getDate()).padStart(2, "0")}`;
      return { start: ws, end: we, inside: now >= ws, key };
    }
  }
  throw new Error("unreachable"); // offset 1 always ends after now
}
