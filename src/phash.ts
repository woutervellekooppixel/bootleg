import sharp from "sharp";

/**
 * Perceptual hash (DCT-based, 64-bit) with sharp: greyscale → 32×32 → 2D DCT → top-left 8×8 →
 * one bit per coefficient, set when it is above the median. Returned as 16 hex digits.
 */
const SIZE = 32;
const SMALL = 8;

// Precomputed cosine terms for the 1D DCT.
const cos: number[][] = [];
for (let x = 0; x < SIZE; x++) {
  cos[x] = [];
  for (let u = 0; u < SIZE; u++) cos[x][u] = Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE));
}

function dct1d(vec: number[]): number[] {
  const out = new Array<number>(SIZE).fill(0);
  for (let u = 0; u < SIZE; u++) {
    let sum = 0;
    for (let x = 0; x < SIZE; x++) sum += vec[x] * cos[x][u];
    out[u] = sum * (u === 0 ? Math.SQRT1_2 : 1);
  }
  return out;
}

function dct2d(matrix: number[][]): number[][] {
  const rows = matrix.map(dct1d);
  const out: number[][] = Array.from({ length: SIZE }, () => new Array<number>(SIZE).fill(0));
  for (let col = 0; col < SIZE; col++) {
    const transformed = dct1d(rows.map((r) => r[col]));
    for (let row = 0; row < SIZE; row++) out[row][col] = transformed[row];
  }
  return out;
}

export async function computePHash(bytes: Buffer): Promise<string> {
  // sharp answers an empty buffer with "Input Buffer is empty", which names the library
  // rather than the cause. Say what actually went wrong instead.
  if (!bytes || bytes.length === 0) throw new Error("cannot hash an empty image (0 bytes)");
  const { data } = await sharp(bytes)
    .rotate() // apply the EXIF orientation, so it matches what Google shows
    .greyscale()
    .resize(SIZE, SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const matrix: number[][] = [];
  for (let y = 0; y < SIZE; y++) {
    const row = new Array<number>(SIZE);
    for (let x = 0; x < SIZE; x++) row[x] = data[y * SIZE + x];
    matrix.push(row);
  }

  const dct = dct2d(matrix);
  const vals: number[] = [];
  for (let y = 0; y < SMALL; y++) for (let x = 0; x < SMALL; x++) vals.push(dct[y][x]);

  // Median without the DC term (index 0).
  const rest = vals.slice(1).sort((a, b) => a - b);
  const median = rest[Math.floor(rest.length / 2)];

  let hash = 0n;
  for (let i = 0; i < 64; i++) hash = (hash << 1n) | (vals[i] > median ? 1n : 0n);
  return hash.toString(16).padStart(16, "0");
}

/** Hamming distance between two 64-bit hex hashes. */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
