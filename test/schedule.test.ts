import assert from "node:assert/strict";
import { test } from "node:test";

import { folderYear, isDue, nightWindow, planNight, rescanIntervalDays, shotTime, yearOf } from "../src/schedule.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 10, 19, 12); // 19 Nov 2026

test("the shoot date comes from the path first", () => {
  assert.equal(shotTime({ rel: "2025/2025-04-22_Show/web/a.jpg", taken: null, mtime: NOW }, NOW), Date.UTC(2025, 3, 22));
  assert.equal(shotTime({ rel: "Phone/IMG_20240105_123000.jpg", taken: null, mtime: NOW }, NOW), Date.UTC(2024, 0, 5));
  assert.equal(shotTime({ rel: "2023/05/06/a.jpg", taken: null, mtime: NOW }, NOW), Date.UTC(2023, 4, 6));
});

test("then the EXIF date, then the file date", () => {
  const taken = Date.UTC(2022, 6, 1, 20, 30);
  assert.equal(shotTime({ rel: "Clients/Smith/a.jpg", taken, mtime: NOW }, NOW), taken);
  assert.equal(shotTime({ rel: "Clients/Smith/a.jpg", taken: null, mtime: NOW - 5 * DAY }, NOW), NOW - 5 * DAY);
});

test("dates must fit a year folder, and the file date is capped at its end", () => {
  // A date from another year in a 2019 folder is not believed; the copy date is capped at the end of 2019.
  assert.equal(shotTime({ rel: "2019/2025-04-22 x/a.jpg", taken: null, mtime: NOW }, NOW), Date.UTC(2020, 0, 1) - 1);
  assert.equal(shotTime({ rel: "2018/x/a.jpg", taken: Date.UTC(2024, 1, 1), mtime: NOW }, NOW), Date.UTC(2019, 0, 1) - 1);
  // Dates in the future are ignored.
  assert.equal(shotTime({ rel: "x/2030-01-01_future/a.jpg", taken: null, mtime: NOW - DAY }, NOW), NOW - DAY);
});

test("year folders and the year a photo counts under", () => {
  assert.equal(folderYear("2025/a/b.jpg"), 2025);
  assert.equal(folderYear("Clients/2025/a.jpg"), null);
  assert.equal(yearOf({ rel: "Clients/a.jpg", taken: Date.UTC(2021, 3, 3), mtime: NOW }), 2021);
});

test("young photos are searched again more often", () => {
  assert.equal(rescanIntervalDays(10), 7);
  assert.equal(rescanIntervalDays(60), 14);
  assert.equal(rescanIntervalDays(100), 30);
  assert.equal(rescanIntervalDays(5000), 365);
  // Every week, with half a day of slack.
  const shot = NOW - 10 * DAY;
  assert.equal(isDue(shot, new Date(NOW - 6.6 * DAY).toISOString(), NOW), true);
  assert.equal(isDue(shot, new Date(NOW - 6.4 * DAY).toISOString(), NOW), false);
});

test("the night queue: newest first, rescans capped while there is a backlog", () => {
  const photo = (name: string, daysOld: number, lastScanDaysAgo: number | null) => ({
    path: `/lib/${name}.jpg`,
    rel: `${name}.jpg`,
    taken: NOW - daysOld * DAY,
    mtime: NOW - daysOld * DAY,
    last_scanned_at: lastScanDaysAgo === null ? null : new Date(NOW - lastScanDaysAgo * DAY).toISOString(),
  });
  const rows = [
    photo("old-new", 400, null),
    photo("young-due", 5, 8), // due: weekly
    photo("young-due2", 6, 8),
    photo("young-due3", 7, 8),
    photo("young-not-due", 5, 1),
    photo("newest", 1, null),
  ];
  const q = planNight(rows, 4, NOW);
  assert.deepEqual(
    q.map((p) => p.rel),
    ["newest.jpg", "young-due.jpg", "young-due2.jpg", "old-new.jpg"],
    "2 of 4 slots for rescans, then the backlog"
  );
  // Budget left over after the backlog goes to the rescans that were held back.
  const fewNew = rows.filter((r) => r.rel !== "newest.jpg");
  assert.deepEqual(planNight(fewNew, 4, NOW).map((p) => p.rel), ["young-due.jpg", "young-due2.jpg", "old-new.jpg", "young-due3.jpg"]);
});

test("night window, also across midnight", () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m);
  let w = nightWindow(at(3), "01:15", "07:00");
  assert.equal(w.inside, true);
  assert.equal(w.key, "2026-11-19");
  assert.equal(w.end.getHours(), 7);

  w = nightWindow(at(8), "01:15", "07:00");
  assert.equal(w.inside, false);
  assert.equal(w.key, "2026-11-20");

  w = nightWindow(at(2), "23:00", "06:00");
  assert.equal(w.inside, true);
  assert.equal(w.key, "2026-11-18", "named after the evening it started");

  w = nightWindow(at(23, 30), "23:00", "06:00");
  assert.equal(w.inside, true);
  assert.equal(w.key, "2026-11-19");

  w = nightWindow(at(12), "23:00", "06:00");
  assert.equal(w.inside, false);
  assert.equal(w.start.getDate(), 19);
});
