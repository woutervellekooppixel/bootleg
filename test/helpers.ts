import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";

/** A fresh, empty data folder for this test file. Call before importing anything that uses the database. */
export function useTempDataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootleg-test-"));
  process.env.BOOTLEG_DATA_DIR = dir;
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bootleg-lib-"));
  process.on("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Small deterministic random numbers, so test images are the same on every run. */
function rng(seed: number) {
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** A photo-like test image: many overlapping shapes with gradients, different for every seed. */
export async function testImage(seed: number, width = 900, height = 600): Promise<Buffer> {
  const r = rng(seed);
  const shapes: string[] = [];
  for (let i = 0; i < 60; i++) {
    const c = () => Math.floor(r() * 255);
    const fill = `rgb(${c()},${c()},${c()})`;
    if (r() < 0.5)
      shapes.push(`<circle cx="${r() * width}" cy="${r() * height}" r="${20 + r() * 140}" fill="${fill}" opacity="${0.5 + r() * 0.5}"/>`);
    else
      shapes.push(
        `<rect x="${r() * width}" y="${r() * height}" width="${30 + r() * 300}" height="${30 + r() * 220}" fill="${fill}" opacity="${0.5 + r() * 0.5}" transform="rotate(${r() * 90 - 45} ${r() * width} ${r() * height})"/>`
      );
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="rgb(${Math.floor(r() * 255)},40,60)"/><stop offset="1" stop-color="rgb(20,${Math.floor(r() * 255)},120)"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>${shapes.join("")}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
