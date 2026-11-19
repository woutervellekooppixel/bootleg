import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { DB_PATH } from "./config.ts";

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,      -- absolute path
    root TEXT NOT NULL,             -- the photo folder (from Settings) it was found in
    rel TEXT NOT NULL,              -- path inside that folder, "/" between levels
    year INTEGER,
    size INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    taken INTEGER,                  -- EXIF date taken (ms), when the file has one
    phash TEXT,
    hash_error TEXT,
    rep_id INTEGER,                 -- NULL = represents its own series
    last_scanned_at TEXT,
    scan_count INTEGER NOT NULL DEFAULT 0,
    missing INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS photos_root ON photos(root, rel);
  CREATE INDEX IF NOT EXISTS photos_rep ON photos(rep_id);

  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    at TEXT NOT NULL,
    status TEXT NOT NULL,           -- ok | error | captcha
    results INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  -- status: open (to review) | action (action needed) | ok (allowed) | notmine | done (resolved) | ignored
  CREATE TABLE IF NOT EXISTS finds (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id),
    url TEXT NOT NULL,
    host TEXT,
    title TEXT,
    thumb TEXT,                     -- data URI of the image Google showed
    similarity INTEGER,             -- 0-100, see similarity.ts
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    status_at TEXT,
    UNIQUE(photo_id, url)
  );

  CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT);
`);

export const STATUSES = ["open", "action", "ok", "notmine", "done", "ignored"] as const;
export type Status = (typeof STATUSES)[number];

export function getState(key: string): string | null {
  const row = db.prepare("SELECT value FROM state WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(key: string, value: string | null): void {
  if (value === null) db.prepare("DELETE FROM state WHERE key = ?").run(key);
  else
    db.prepare("INSERT INTO state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      value
    );
}

export const nowIso = () => new Date().toISOString();
