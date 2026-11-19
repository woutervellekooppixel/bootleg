import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";

import { computePHash, hammingDistance } from "../src/phash.ts";
import { bestSimilarity } from "../src/similarity.ts";
import { testImage } from "./helpers.ts";

const dataUri = (b: Buffer) => `data:image/jpeg;base64,${b.toString("base64")}`;

test("pHash: the same photo in another size is close, another photo is far", async () => {
  const a = await testImage(1);
  const smaller = await sharp(a).resize(300).jpeg({ quality: 60 }).toBuffer();
  const other = await testImage(2);
  const [ha, hs, ho] = await Promise.all([computePHash(a), computePHash(smaller), computePHash(other)]);
  assert.ok(hammingDistance(ha, hs) <= 4, `resized: ${hammingDistance(ha, hs)}`);
  assert.ok(hammingDistance(ha, ho) > 16, `other: ${hammingDistance(ha, ho)}`);
  await assert.rejects(computePHash(Buffer.alloc(0)), /empty image/);
});

test("similarity: a crop of your photo scores high, another photo low", async () => {
  const photo = await testImage(3);
  // A 4:5 crop from the middle, as on Instagram, as a small thumbnail.
  const crop = await sharp(photo).extract({ left: 260, top: 60, width: 384, height: 480 }).resize(150).jpeg({ quality: 75 }).toBuffer();
  const whole = await sharp(photo).resize(200).jpeg({ quality: 70 }).toBuffer();
  const other = await sharp(await testImage(4)).resize(150).jpeg().toBuffer();

  const simCrop = await bestSimilarity(photo, dataUri(crop));
  const simWhole = await bestSimilarity(photo, dataUri(whole));
  const simOther = await bestSimilarity(photo, dataUri(other));
  // The default threshold is 75 (see Settings → Matching).
  assert.ok(simWhole! >= 90, `whole: ${simWhole}`);
  assert.ok(simCrop! >= 75, `crop: ${simCrop}`);
  assert.ok(simOther! < 65, `other: ${simOther}`);
  assert.equal(await bestSimilarity(photo, null), null);
});
