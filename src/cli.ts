import { SETTINGS_PATH } from "./config.ts";
import { budgetState } from "./budget.ts";
import { db } from "./db.ts";
import { jobState, startJob, stopJob, type JobKind, type JobOptions } from "./jobs.ts";
import { pickQueue } from "./scanner.ts";
import { nightWindow } from "./schedule.ts";
import { loadSettings } from "./settings.ts";

/**
 * The same work as the app, from the command line. Useful for cron instead of the app's own
 * night schedule, and for trying things out.
 */

const log = (s: string) => console.log(`${new Date().toLocaleTimeString()} ${s}`);
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function run(kind: JobKind, opts: JobOptions = {}) {
  const job = startJob(kind, { ...opts, log });
  if (!job) {
    const other = jobState();
    console.error(`Photowatch is busy${other ? ` (${other.kind}, since ${new Date(other.startedAt).toLocaleTimeString()})` : ""}. Try again later.`);
    process.exit(2);
  }
  // Ctrl-C stops after the current photo, like the Stop button in the app.
  process.once("SIGINT", () => {
    log("Stopping after the current photo… (press Ctrl-C again to quit at once)");
    stopJob();
    process.once("SIGINT", () => process.exit(130));
  });
  const summary = await job;
  if (summary.error) process.exitCode = 1;
}

switch (process.argv[2]) {
  case "index":
    await run("index");
    break;

  case "scan":
    await run("scan", { count: Number(arg("count") ?? 10), folder: arg("folder") });
    break;

  case "nightly": {
    // For cron: one night run now, until the end of the night window (or as long as the window is).
    const s = loadSettings().schedule;
    const w = nightWindow(new Date(), s.start, s.end);
    const deadline = w.inside ? w.end.getTime() : Date.now() + (w.end.getTime() - w.start.getTime());
    await run("night", { deadline });
    break;
  }

  case "status": {
    const st = db
      .prepare(
        `SELECT COUNT(*) photos, SUM(phash IS NULL AND hash_error IS NULL) unhashed, SUM(hash_error IS NOT NULL) hash_errors,
                SUM(rep_id IS NULL) reps, SUM(rep_id IS NULL AND last_scanned_at IS NOT NULL) scanned
         FROM photos WHERE missing = 0`
      )
      .get();
    console.log("Settings:", SETTINGS_PATH);
    console.log("Folders:", loadSettings().folders.map((f) => f.path));
    console.log("Photos:", st);
    console.log("Finds:", db.prepare("SELECT COUNT(*) finds, COUNT(DISTINCT photo_id) photos FROM finds").get());
    console.log("Pace:", budgetState());
    console.log("Next in the queue:", pickQueue(5).map((p) => p.rel));
    const job = jobState();
    if (job) console.log("Running now:", job);
    break;
  }

  default:
    console.log(`Usage:
  npm start                                  the app with its night schedule (http://localhost:4410)
  npm run index                              read the photo folders now
  npm run scan -- --count 5 [--folder PATH]  search a few photos now
  npm run nightly                            one night run now (for cron)
  npm run status                             progress and settings file`);
}
