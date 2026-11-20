import { execFile } from "node:child_process";
import fs from "node:fs";

import { HASH_HOURS_PER_NIGHT, LOCK_PATH } from "./config.ts";
import { budgetForTonight } from "./budget.ts";
import { getState, nowIso, setState } from "./db.ts";
import { groupBursts, hashPending, syncFiles, type StepContext } from "./indexer.ts";
import { runScan, type ScanSummary } from "./scanner.ts";
import { nightWindow } from "./schedule.ts";
import { loadSettings } from "./settings.ts";

/**
 * Long-running work, one job at a time: reading folders ("index"), a search by hand ("scan")
 * and the night run ("night"). A lock file keeps the app and the command line from
 * searching at the same time, since both would need the same browser profile.
 */

export type JobKind = "index" | "scan" | "night";

export interface JobState {
  kind: JobKind;
  startedAt: string;
  phase: string;
  done: number;
  total: number;
  current: string | null;
  stopping: boolean;
  /** Running in another process (the command line, or a second app). */
  elsewhere: boolean;
}

export interface RunSummary {
  kind: JobKind;
  startedAt: string;
  endedAt: string;
  photos?: number;
  added?: number;
  unavailable?: string[];
  scanned?: number;
  errors?: number;
  newFinds?: number;
  stoppedBy?: ScanSummary["stoppedBy"] | "no-folders";
  error?: string;
}

// ---------- lock ----------

interface Lock {
  pid: number;
  kind: JobKind;
  startedAt: string;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Who holds the lock, if the process is still running. */
export function lockHolder(): Lock | null {
  try {
    const lock = JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Lock;
    return alive(lock.pid) ? lock : null;
  } catch {
    return null;
  }
}

function acquire(kind: JobKind): boolean {
  const lock = JSON.stringify({ pid: process.pid, kind, startedAt: nowIso() } satisfies Lock);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(LOCK_PATH, lock, { flag: "wx" });
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockHolder()) return false;
      fs.rmSync(LOCK_PATH, { force: true }); // left behind by a process that is gone
    }
  }
  return false;
}

function release(): void {
  try {
    if ((JSON.parse(fs.readFileSync(LOCK_PATH, "utf8")) as Lock).pid === process.pid) fs.rmSync(LOCK_PATH, { force: true });
  } catch {
    // no lock
  }
}
process.on("exit", release);

// ---------- notifications ----------

export function notify(title: string, text: string): void {
  try {
    if (!loadSettings().notifications) return;
  } catch {
    return;
  }
  const done = () => {};
  if (process.platform === "darwin")
    execFile("osascript", ["-e", `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], done);
  else if (process.platform === "linux") execFile("notify-send", [title, text], done);
}

// ---------- jobs ----------

let current: { state: JobState; stop: boolean } | null = null;

export function jobState(): JobState | null {
  if (current) return { ...current.state, stopping: current.stop };
  const other = lockHolder();
  if (!other || other.pid === process.pid) return null;
  return { kind: other.kind, startedAt: other.startedAt, phase: "Running in another Bootleg process", done: 0, total: 0, current: null, stopping: false, elsewhere: true };
}

export function stopJob(): boolean {
  if (!current) return false;
  current.stop = true;
  return true;
}

export const lastRun = (): RunSummary | null => JSON.parse(getState("last_run") ?? "null");

export interface JobOptions {
  /** scan: number of photos. */
  count?: number;
  /** scan: only this folder. */
  folder?: string;
  /** night: stop searching at this time (ms). */
  deadline?: number;
  log?: (s: string) => void;
}

/** Starts a job and returns its result, or null when another job is running. */
export function startJob(kind: JobKind, opts: JobOptions = {}): Promise<RunSummary> | null {
  if (current || !acquire(kind)) return null;
  const state: JobState = { kind, startedAt: nowIso(), phase: "Starting", done: 0, total: 0, current: null, stopping: false, elsewhere: false };
  const job = { state, stop: false };
  current = job;
  const log = opts.log ?? ((s: string) => console.log(`${new Date().toLocaleTimeString()} ${s}`));
  const step = (phase: string, extra: Partial<StepContext> = {}): StepContext => {
    Object.assign(state, { phase, done: 0, total: 0, current: null });
    return {
      shouldStop: () => job.stop,
      log,
      progress: (done, total, cur) => Object.assign(state, { done, total, current: cur ?? null }),
      ...extra,
    };
  };
  const summary: RunSummary = { kind, startedAt: state.startedAt, endedAt: state.startedAt };

  const index = async (hashDeadline?: number) => {
    const s = await syncFiles(loadSettings().folders, step("Reading folders"));
    log(`${s.total} photos (${s.added} new, ${s.changed} changed, ${s.missing} gone)`);
    Object.assign(summary, { photos: s.total, added: s.added, unavailable: s.unavailable });
    const n = await hashPending(step("Fingerprinting photos", { deadline: hashDeadline }));
    if (n) log(`${n} photos fingerprinted`);
    step("Grouping series");
    const g = groupBursts();
    log(`${g.reps} series; ${g.members} photos belong to a series`);
    return s;
  };

  const run = (async (): Promise<RunSummary> => {
    try {
      if (!loadSettings().folders.length) {
        summary.stoppedBy = "no-folders";
        log("No photo folders yet: add them in Settings.");
        return summary;
      }
      if (kind === "index") await index();

      if (kind === "scan") {
        const s = await runScan({ ...step("Searching"), budget: opts.count ?? 10, folder: opts.folder });
        Object.assign(summary, s);
      }

      if (kind === "night") {
        const deadline = opts.deadline ?? Date.now() + 6 * 3_600_000;
        const sched = loadSettings().schedule;
        const w = nightWindow(new Date(), sched.start, sched.end);
        if (w.inside) setState("night_done", w.key); // so the app does not run this night again
        const s = await index(Math.min(deadline, Date.now() + HASH_HOURS_PER_NIGHT * 3_600_000));
        if (s.unavailable.length) notify("Bootleg", `Cannot read ${s.unavailable.length === 1 ? s.unavailable[0] : `${s.unavailable.length} photo folders`}.`);
        if (!job.stop) {
          const budget = budgetForTonight(log);
          log(`Tonight: up to ${budget} photos`);
          const r = await runScan({ ...step("Searching"), budget, deadline, adaptive: true });
          Object.assign(summary, r);
          if (r.stoppedBy === "captcha") notify("Bootleg", "Google asked for a captcha. Bootleg pauses for a day.");
        } else summary.stoppedBy = "stopped";
      }

      if (summary.newFinds) notify("Bootleg", `${summary.newFinds} new ${summary.newFinds === 1 ? "find" : "finds"} of your photos.`);
      if (summary.scanned !== undefined)
        log(`Done: ${summary.scanned} searched, ${summary.errors} errors, ${summary.newFinds} new finds (${summary.stoppedBy})`);
      return summary;
    } catch (e) {
      summary.error = (e as Error).message.split("\n")[0];
      log(`Stopped with an error: ${summary.error}`);
      return summary;
    } finally {
      summary.endedAt = nowIso();
      setState("last_run", JSON.stringify(summary));
      current = null;
      release();
    }
  })();
  return run;
}

// ---------- night schedule ----------

/** Checks every minute whether the night run is due, and starts it. */
export function startScheduler(log: (s: string) => void): void {
  const tick = () => {
    try {
      const s = loadSettings();
      if (!s.schedule.enabled || !s.folders.length || current || lockHolder()) return;
      const w = nightWindow(new Date(), s.schedule.start, s.schedule.end);
      // Not when the window is (nearly) over: a restart at 06:55 should not start a night.
      if (!w.inside || w.end.getTime() - Date.now() < 10 * 60_000) return;
      if (getState("night_done") === w.key) return;
      log(`Night run started (until ${s.schedule.end})`);
      startJob("night", { deadline: w.end.getTime(), log })?.catch((e) => log(`Night run failed: ${(e as Error).message}`));
    } catch (e) {
      log(`Schedule: ${(e as Error).message}`);
    }
  };
  setTimeout(tick, 5_000);
  setInterval(tick, 60_000);
}
