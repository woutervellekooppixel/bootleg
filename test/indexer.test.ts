import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import sharp from "sharp";

import { tempDir, testImage, useTempDataDir } from "./helpers.ts";

useTempDataDir();
const { db } = await import("../src/db.ts");
const { groupBursts, hashPending, syncFiles, shootOf } = await import("../src/indexer.ts");
const { saveSettings, loadSettings } = await import("../src/settings.ts");
const { pickQueue } = await import("../src/scanner.ts");

const lib = tempDir();
const put = async (rel: string, img: Buffer) => {
  fs.mkdirSync(path.dirname(path.join(lib, rel)), { recursive: true });
  fs.writeFileSync(path.join(lib, rel), img);
};

const photos = () =>
  db.prepare("SELECT rel, missing, rep_id IS NOT NULL AS member, taken, year FROM photos ORDER BY rel").all() as {
    rel: string;
    missing: number;
    member: number;
    taken: number | null;
    year: number;
  }[];

test("shoots are the folder up to two levels deep", () => {
  assert.equal(shootOf("2025/2025-04-22 Show/web/IMG_1.jpg"), "2025/2025-04-22 Show");
  assert.equal(shootOf("Smith wedding/IMG_1.jpg"), "Smith wedding");
  assert.equal(shootOf("IMG_1.jpg"), "");
});

test("reading a folder: JPGs only, skipped and hidden folders left out", async () => {
  const a = await testImage(10);
  const withDate = await sharp(await testImage(12)).withExif({ IFD2: { DateTimeOriginal: "2023:05:06 10:11:12" } }).jpeg().toBuffer();
  await put("2025/2025-01-02_A/a.jpg", a);
  await put("2025/2025-01-02_A/web/a-small.jpg", await sharp(a).resize(400).jpeg({ quality: 70 }).toBuffer()); // same frame, smaller export
  await put("2025/2025-02-03_B/c.JPG", await testImage(11));
  await put("Clients/x.jpeg", withDate);
  await put("iphone backup/d.jpg", await testImage(13));
  await put(".thumbnails/e.jpg", await testImage(14));
  await put("2025/2025-01-02_A/notes.txt", Buffer.from("not a photo"));

  await saveSettings({ folders: [{ path: lib, exclude: ["iphone backup"] }] });
  const s = await syncFiles();
  assert.deepEqual({ total: s.total, added: s.added, unavailable: s.unavailable }, { total: 4, added: 4, unavailable: [] });

  assert.equal(await hashPending(), 4);
  const g = groupBursts();
  assert.deepEqual(g, { reps: 3, members: 1 }, "the small export joins the series of the original");

  const byRel = Object.fromEntries(photos().map((p) => [p.rel, p]));
  assert.equal(byRel["2025/2025-01-02_A/web/a-small.jpg"].member, 1);
  assert.equal(byRel["Clients/x.jpeg"].taken, Date.UTC(2023, 4, 6, 10, 11, 12), "EXIF date taken");
  assert.equal(byRel["Clients/x.jpeg"].year, 2023);
  assert.deepEqual(pickQueue(10).map((p) => p.rel), ["2025/2025-02-03_B/c.JPG", "2025/2025-01-02_A/a.jpg", "Clients/x.jpeg"], "newest shoot first, representatives only");
});

test("skipping and unskipping a subfolder", async () => {
  await saveSettings({ folders: [{ path: lib, exclude: ["iphone backup", "2025/2025-02-03_B"] }] });
  let s = await syncFiles();
  assert.equal(s.missing, 1);
  assert.equal(photos().find((p) => p.rel === "2025/2025-02-03_B/c.JPG")!.missing, 1);

  await saveSettings({ folders: [{ path: lib, exclude: [] }] });
  s = await syncFiles();
  assert.equal(s.added, 1, "iphone backup is read now");
  assert.equal(photos().find((p) => p.rel === "2025/2025-02-03_B/c.JPG")!.missing, 0, "back, with its history");
});

test("an offline folder does not make its photos disappear", async () => {
  const second = tempDir();
  fs.writeFileSync(path.join(second, "z.jpg"), await testImage(20));
  await saveSettings({ folders: [...loadSettings().folders, { path: second, exclude: [] }] });
  await syncFiles();
  const parked = `${second}-unplugged`;
  fs.renameSync(second, parked);
  const s = await syncFiles();
  assert.deepEqual(s.unavailable, [second]);
  assert.equal(s.missing, 0);
  fs.renameSync(parked, second);

  // Removing the folder from Settings does make them disappear.
  await saveSettings({ folders: loadSettings().folders.filter((f) => f.path !== second) });
  assert.equal((await syncFiles()).missing, 1);
});
