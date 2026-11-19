import fs from "node:fs/promises";
import path from "node:path";

import { BURST_MAX_DISTANCE, PHOTO_EXTENSIONS, SHOOT_DEPTH } from "./config.ts";
import { db } from "./db.ts";
import { dateTaken } from "./exif.ts";
import { computePHash, hammingDistance } from "./phash.ts";
import { yearOf } from "./schedule.ts";
import { folderReadable, loadSettings, type PhotoFolder } from "./settings.ts";

export interface StepContext {
  shouldStop?: () => boolean;
  deadline?: number;
  log?: (s: string) => void;
  progress?: (done: number, total: number, current?: string) => void;
}

/** `rel` is `exclude` itself or lies inside it. */
export const isExcluded = (rel: string, exclude: string[]) => exclude.some((e) => rel === e || rel.startsWith(`${e}/`));

/** The shoot a photo belongs to: its folder, at most SHOOT_DEPTH levels deep. */
export const shootOf = (rel: string) => rel.split("/").slice(0, -1).slice(0, SHOOT_DEPTH).join("/");

interface Found {
  abs: string;
  rel: string;
  size: number;
  mtime: number;
}

/** All photos in one folder. `complete` is false when a subfolder could not be read or the walk was stopped. */
async function readFolder(folder: PhotoFolder, ctx: StepContext, onFile: () => void): Promise<{ files: Found[]; complete: boolean }> {
  const files: Found[] = [];
  let complete = true;
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      complete = false;
      ctx.log?.(`Cannot read ${dir}: ${(e as Error).message.split("\n")[0]}`);
      return;
    }
    for (const e of entries) {
      if (ctx.shouldStop?.()) {
        complete = false;
        return;
      }
      if (e.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!isExcluded(r, folder.exclude)) await walk(abs, r);
      } else if (e.isFile() && PHOTO_EXTENSIONS.test(e.name)) {
        const st = await fs.stat(abs).catch(() => null);
        if (!st) {
          complete = false;
          continue;
        }
        files.push({ abs, rel: r, size: st.size, mtime: Math.floor(st.mtimeMs) });
        onFile();
      }
    }
  }
  await walk(folder.path, "");
  return { files, complete };
}

export interface SyncResult {
  total: number;
  added: number;
  changed: number;
  missing: number;
  /** Photo folders that could not be read at all (an unplugged drive, say). */
  unavailable: string[];
}

/**
 * Inventory: add new and changed photos, and mark photos that are gone as missing. Photos in a
 * folder that could not be read completely are left as they are: an offline drive does not
 * mean the photos are gone.
 */
export async function syncFiles(folders: PhotoFolder[] = loadSettings().folders, ctx: StepContext = {}): Promise<SyncResult> {
  type Known = { root: string; rel: string; size: number; mtime: number; missing: number };
  const known = new Map<string, Known>();
  for (const r of db.prepare("SELECT path, root, rel, size, mtime, missing FROM photos").all() as (Known & { path: string })[])
    known.set(r.path, r);

  const insert = db.prepare("INSERT INTO photos(path, root, rel, year, size, mtime) VALUES(?, ?, ?, ?, ?, ?)");
  const changedFile = db.prepare(
    "UPDATE photos SET root = ?, rel = ?, year = ?, size = ?, mtime = ?, phash = NULL, hash_error = NULL, taken = NULL, missing = 0 WHERE path = ?"
  );
  const moved = db.prepare("UPDATE photos SET root = ?, rel = ?, year = ?, missing = 0 WHERE path = ?");

  const seen = new Set<string>();
  const unavailable: string[] = [];
  const uncertain = new Set<string>();
  let added = 0;
  let changed = 0;
  let counted = 0;

  for (const folder of folders) {
    if (ctx.shouldStop?.()) {
      uncertain.add(folder.path);
      continue;
    }
    if (!(await folderReadable(folder.path))) {
      unavailable.push(folder.path);
      ctx.log?.(`Not available: ${folder.path}`);
      continue;
    }
    const { files, complete } = await readFolder(folder, ctx, () => ctx.progress?.(++counted, 0));
    if (!complete) uncertain.add(folder.path);
    // Written in one go, without awaiting in between, so nothing else ends up in this transaction.
    db.exec("BEGIN");
    for (const f of files) {
      seen.add(f.abs);
      const prev = known.get(f.abs);
      const year = yearOf({ rel: f.rel, taken: null, mtime: f.mtime });
      if (!prev) {
        insert.run(f.abs, folder.path, f.rel, year, f.size, f.mtime);
        added++;
      } else if (prev.size !== f.size || prev.mtime !== f.mtime) {
        changedFile.run(folder.path, f.rel, year, f.size, f.mtime, f.abs);
        changed++;
      } else if (prev.root !== folder.path || prev.rel !== f.rel || prev.missing) {
        moved.run(folder.path, f.rel, year, f.abs);
      }
    }
    db.exec("COMMIT");
  }

  const configured = new Set(folders.map((f) => f.path));
  const skip = new Set([...unavailable, ...uncertain]);
  const setMissing = db.prepare("UPDATE photos SET missing = 1 WHERE path = ?");
  let missing = 0;
  db.exec("BEGIN");
  for (const [p, r] of known) {
    if (r.missing || seen.has(p)) continue;
    if (configured.has(r.root) && skip.has(r.root)) continue; // cannot tell right now
    setMissing.run(p);
    missing++;
  }
  db.exec("COMMIT");

  return { total: seen.size, added, changed, missing, unavailable };
}

/**
 * Fingerprint (pHash) and EXIF date for photos that do not have them yet, newest years first.
 * A file that cannot be read is skipped and tried again next time; a file that cannot be
 * decoded gets an error and is left alone until it changes.
 */
export async function hashPending(ctx: StepContext = {}): Promise<number> {
  const rows = db
    .prepare("SELECT id, path, root, rel, mtime FROM photos WHERE phash IS NULL AND hash_error IS NULL AND missing = 0 ORDER BY year DESC, rel")
    .all() as { id: number; path: string; root: string; rel: string; mtime: number }[];
  const ok = db.prepare("UPDATE photos SET phash = ?, taken = ?, year = ? WHERE id = ?");
  const fail = db.prepare("UPDATE photos SET hash_error = ? WHERE id = ?");
  const offline = new Set<string>();
  let done = 0;
  for (const [i, r] of rows.entries()) {
    if (ctx.shouldStop?.() || (ctx.deadline && Date.now() > ctx.deadline)) break;
    if (offline.has(r.root)) continue;
    ctx.progress?.(i, rows.length, r.rel);
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(r.path);
    } catch {
      if (!(await folderReadable(r.root))) {
        offline.add(r.root);
        ctx.log?.(`Not available: ${r.root}`);
      }
      continue;
    }
    try {
      const [hash, taken] = await Promise.all([computePHash(bytes), dateTaken(bytes)]);
      ok.run(hash, taken, yearOf({ rel: r.rel, taken, mtime: r.mtime }), r.id);
    } catch (e) {
      fail.run(String((e as Error).message ?? e).slice(0, 300), r.id);
    }
    done++;
    if (done % 500 === 0) ctx.log?.(`  ${done}/${rows.length} fingerprinted`);
  }
  return done;
}

/**
 * Group near-identical photos per shoot (bursts, or the same frame exported twice): a photo
 * within BURST_MAX_DISTANCE of an earlier representative in the same shoot joins its series.
 * Only representatives are searched; a find counts for the whole series.
 */
export function groupBursts(): { reps: number; members: number } {
  const rows = db.prepare("SELECT id, root, rel, phash, rep_id FROM photos WHERE missing = 0 ORDER BY root, rel").all() as {
    id: number;
    root: string;
    rel: string;
    phash: string | null;
    rep_id: number | null;
  }[];
  const setRep = db.prepare("UPDATE photos SET rep_id = ? WHERE id = ?");
  const repsByShoot = new Map<string, { id: number; phash: string }[]>();
  let reps = 0;
  let members = 0;
  db.exec("BEGIN");
  for (const r of rows) {
    const shoot = `${r.root}\0${shootOf(r.rel)}`;
    const shootReps = repsByShoot.get(shoot) ?? [];
    const match = r.phash ? shootReps.find((x) => hammingDistance(x.phash, r.phash!) <= BURST_MAX_DISTANCE) : undefined;
    const rep = match ? match.id : null;
    if (rep !== r.rep_id) setRep.run(rep, r.id);
    if (match) {
      members++;
      continue;
    }
    reps++;
    if (r.phash) repsByShoot.set(shoot, [...shootReps, { id: r.id, phash: r.phash }]);
  }
  db.exec("COMMIT");
  return { reps, members };
}
