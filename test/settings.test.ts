import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { tempDir, useTempDataDir } from "./helpers.ts";

useTempDataDir();
const { DEFAULTS, isIgnoredHost, loadSettings, normalizeHost, saveSettings, validate, SettingsError } = await import("../src/settings.ts");

test("website addresses are cleaned up", () => {
  assert.equal(normalizeHost("https://www.Example.com/some/page?x=1"), "example.com");
  assert.equal(normalizeHost("shop.example.co.uk"), "shop.example.co.uk");
  assert.equal(normalizeHost("example.com:8080"), "example.com");
  assert.equal(normalizeHost("not a site"), null);
  assert.equal(normalizeHost("localhost"), null);
  assert.equal(isIgnoredHost("photos.example.com", ["example.com"]), true);
  assert.equal(isIgnoredHost("notexample.com", ["example.com"]), false);
});

test("folders: full paths, no nesting, clean exclusions", () => {
  const s = validate({ folders: [{ path: "/photos/jpg/", exclude: ["\\2019\\private\\", "iphone backup", "iphone backup", ""] }] });
  assert.deepEqual(s.folders, [{ path: "/photos/jpg", exclude: ["2019/private", "iphone backup"] }]);
  assert.throws(() => validate({ folders: [{ path: "photos" }] }), SettingsError);
  assert.throws(() => validate({ folders: ["/photos", "/photos/2025"] }), /inside the other/);
  assert.throws(() => validate({ folders: ["/photos", "/photos/"] }), /already in the list/);
  assert.throws(() => validate({ folders: [{ path: "/photos", exclude: ["../etc"] }] }), /Not a subfolder/);
  assert.deepEqual(validate({ folders: ["/a", "/ab"] }).folders.map((f) => f.path), ["/a", "/ab"], "/ab is not inside /a");
});

test("other values are checked", () => {
  assert.throws(() => validate({ schedule: { start: "25:00" } }), /time like 01:15/);
  assert.throws(() => validate({ schedule: { start: "07:00", end: "07:00" } }), /differs/);
  assert.equal(validate({ schedule: { end: "06:30" } }).schedule.start, DEFAULTS.schedule.start, "partial changes keep the rest");
  assert.throws(() => validate({ maxPerNight: 5 }), /from 10 to 1000/);
  assert.throws(() => validate({ minSimilarity: 100 }), /from 50 to 99/);
  assert.throws(() => validate({ browser: "safari" }), /Browser must be/);
  assert.equal(validate({ claimTemplate: "   " }).claimTemplate, DEFAULTS.claimTemplate, "an empty letter falls back to the standard text");
  assert.equal(validate({ unknown: 1 }).maxPerNight, DEFAULTS.maxPerNight);
});

test("a new folder must exist; a known folder may be offline", async () => {
  const lib = tempDir();
  await assert.rejects(saveSettings({ folders: [path.join(lib, "nope")] }), /Folder not found/);
  await saveSettings({ folders: [lib], ignoredHosts: ["https://www.mysite.com/"] });
  assert.deepEqual(loadSettings().ignoredHosts, ["mysite.com"]);
  fs.rmSync(lib, { recursive: true });
  // The drive is gone, but changing something else still works.
  await saveSettings({ maxPerNight: 300 });
  assert.equal(loadSettings().folders[0].path, lib);
  assert.equal(loadSettings().maxPerNight, 300);
});
