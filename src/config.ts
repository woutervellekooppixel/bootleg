import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fixed values and file locations. Everything a user may want to change lives in
 * settings.ts (and on the Settings screen); this file holds the tuning that was
 * measured once and rarely needs touching.
 */

export const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Everything Photowatch writes (database, settings, browser profile, image cache) lives here. */
export const DATA_DIR = path.resolve(process.env.PHOTOWATCH_DATA_DIR ?? path.join(PROJECT_DIR, "data"));
export const DB_PATH = path.join(DATA_DIR, "photowatch.db");
export const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
export const BROWSER_PROFILE = path.join(DATA_DIR, "browser-profile");
export const CACHE_DIR = path.join(DATA_DIR, "cache");
export const LOCK_PATH = path.join(DATA_DIR, "scan.lock");

/** The app only listens on this machine (127.0.0.1). */
export const PORT = Number(process.env.PHOTOWATCH_PORT ?? 4410);

/**
 * Extra host names the app may be reached on, comma-separated, e.g. when you put it
 * behind `tailscale serve`. Requests with any other Host header are refused, which
 * stops DNS-rebinding tricks from other websites.
 */
export const ALLOWED_HOSTS = (process.env.PHOTOWATCH_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim().toLowerCase())
  .filter(Boolean);

/** Photos with these extensions are indexed. */
export const PHOTO_EXTENSIONS = /\.jpe?g$/i;

/** "Recent" in the progress numbers = this year and the two years before. */
export const RECENT_YEARS = 3;

/**
 * Rescanning: the younger the photo (since the shoot date), the more often, because
 * publications often appear weeks or months later. [age up to (days), rescan every (days)].
 */
export const RESCAN_SCHEDULE: [number, number][] = [
  [30, 7], //        first month: every week
  [90, 14], //       up to 3 months: every 2 weeks
  [180, 30], //      up to half a year: every month
  [365, 60], //      up to a year: every 2 months
  [730, 120], //     up to 2 years: every 4 months
  [Infinity, 365], // older: once a year
];

/**
 * While there are photos that were never scanned, rescans get at most this share of the
 * night, so the backlog keeps shrinking. New photos always come first.
 */
export const RESCAN_SHARE = 0.5;

/**
 * Searches per night adapt to Google: start at BUDGET_START, add BUDGET_STEP after every
 * BUDGET_RAMP_DAYS without a captcha (up to the maximum in Settings), halve after a captcha
 * (down to BUDGET_MIN).
 */
export const BUDGET_START = 200;
export const BUDGET_STEP = 50;
export const BUDGET_MIN = 50;
export const BUDGET_RAMP_DAYS = 7;

/** Random pause between two searches. Measured: a search plus pause takes about 28 s. */
export const DELAY_MS: [number, number] = [15_000, 35_000];

/** After a captcha, do not try again for this long. */
export const CAPTCHA_BACKOFF_HOURS = 24;

/** The night scan spends at most this long computing fingerprints before it starts searching. */
export const HASH_HOURS_PER_NIGHT = 2;

/**
 * Photos in the same shoot with a pHash distance up to this count as the same photo
 * (bursts, the same frame in a small and a large export). Only one of them is searched;
 * a find counts for the whole series.
 */
export const BURST_MAX_DISTANCE = 8;

/**
 * A shoot is the folder this many levels below the photo folder, for example
 * `2025/2025-04-22 Concert` in `Photos/2025/2025-04-22 Concert/web/IMG_1.jpg`.
 * Series are only formed within one shoot.
 */
export const SHOOT_DEPTH = 2;

/** Thumbnails of found images are kept from this similarity up, so you can lower the threshold later. */
export const KEEP_THUMB_FROM = 50;

/** Longest side of the image that is uploaded to Lens. */
export const UPLOAD_MAX_PX = 1000;
