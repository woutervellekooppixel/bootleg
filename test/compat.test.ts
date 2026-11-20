import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { databasePath, envVar } from "../src/config.ts";
import { tempDir } from "./helpers.ts";

// Bootleg was called Photowatch until November 2026. An install from before the rename keeps
// working: its environment variables, its data folder and the database in it.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("environment variables: the BOOTLEG_ name, else the old PHOTOWATCH_ name", () => {
  assert.equal(envVar("DATA_DIR", { BOOTLEG_DATA_DIR: "/new" }), "/new");
  assert.equal(envVar("DATA_DIR", { PHOTOWATCH_DATA_DIR: "/old" }), "/old");
  assert.equal(envVar("PORT", { BOOTLEG_PORT: "4412", PHOTOWATCH_PORT: "4411" }), "4412", "the new name wins");
  assert.equal(envVar("ALLOWED_HOSTS", { BOOTLEG_ALLOWED_HOSTS: "", PHOTOWATCH_ALLOWED_HOSTS: "my-mac.example" }), "my-mac.example", "empty counts as not set");
  assert.equal(envVar("PORT", {}), undefined);
});

test("the database: bootleg.db in a new data folder, photowatch.db where one is already there", () => {
  const dir = tempDir();
  assert.equal(databasePath(dir), path.join(dir, "bootleg.db"), "a new install");
  fs.writeFileSync(path.join(dir, "photowatch.db"), "");
  assert.equal(databasePath(dir), path.join(dir, "photowatch.db"), "an install from before the rename");
  fs.writeFileSync(path.join(dir, "bootleg.db"), "");
  assert.equal(databasePath(dir), path.join(dir, "bootleg.db"), "both there: the one Bootleg made");
});

test("an install from before the rename keeps its data, port and host names", async () => {
  // A data folder as Photowatch left it: its settings, and a pace it had reached (a new install starts at 200).
  const dataDir = tempDir();
  fs.writeFileSync(path.join(dataDir, "settings.json"), JSON.stringify({ maxPerNight: 300 }));
  const old = new DatabaseSync(path.join(dataDir, "photowatch.db"));
  old.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)");
  old.prepare("INSERT INTO state(key, value) VALUES (?, ?), (?, ?)").run("budget", "120", "budget_since", new Date().toISOString());
  old.close();

  // Started the way an existing launch agent or script starts it: with only the old names.
  const port = await freePort();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(BOOTLEG|PHOTOWATCH)_/.test(k)));
  const app = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: root,
    env: { ...env, PHOTOWATCH_DATA_DIR: dataDir, PHOTOWATCH_PORT: String(port), PHOTOWATCH_ALLOWED_HOSTS: "my-mac.example.ts.net" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await listening(app, port);
    const r = await getJson(port, "/api/data", "my-mac.example.ts.net");
    assert.equal(r.status, 200, "the host name from PHOTOWATCH_ALLOWED_HOSTS");
    assert.equal(r.json.budget.budget, 120, "the pace from photowatch.db");
    assert.equal(r.json.budget.max, 300, "the settings from the old data folder");
    assert.equal(fs.existsSync(path.join(dataDir, "bootleg.db")), false, "no second, empty database next to it");
  } finally {
    await stop(app);
  }
});

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });
}

/** Resolves once the app says it listens on `port`. */
function listening(app: ChildProcess, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the app did not start")), 20_000);
    app.once("exit", (code) => reject(new Error(`the app stopped (exit code ${code})`)));
    app.stdout!.on("data", (b: Buffer) => {
      if (b.toString().includes(`http://localhost:${port}`)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

function getJson(port: number, url: string, host: string): Promise<{ status: number; json: any }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: url, headers: { host } }, (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          let json: any = null;
          try {
            json = JSON.parse(text);
          } catch {}
          resolve({ status: res.statusCode!, json });
        });
      })
      .on("error", reject);
  });
}

async function stop(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.signalCode !== null) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  app.kill();
  await exited;
}
