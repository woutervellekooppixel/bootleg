import sharp from "sharp";

/**
 * How much does a found thumbnail look like (a part of) your own photo?
 *
 * Websites often show a crop: 4:5 on Instagram, a strip from a panorama on a news site. So the
 * thumbnail is searched for inside the photo: at several scales and positions we compute the
 * normalised cross-correlation (NCC) on greyscale pixels and keep the best. A real copy or crop
 * scores high; another photo of the same subject (say, a logo that also appears in your photo)
 * scores clearly lower. Measured on real finds: copies and crops 77-96, an unrelated photo that
 * happens to contain the same logo 64 or less, the same show by another photographer around 68.
 *
 * Returns 0-100, or null when the thumbnail cannot be used.
 */
const PHOTO_W = 160;
const SCALES = [1, 0.85, 0.72, 0.6, 0.5, 0.42, 0.35, 0.28];
const STRIDE = 2;

async function gray(input: Buffer, w: number, h: number): Promise<Float32Array> {
  const { data } = await sharp(input).rotate().greyscale().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return Float32Array.from(data);
}

function normalize(v: Float32Array): Float32Array | null {
  let mean = 0;
  for (const x of v) mean += x;
  mean /= v.length;
  let ss = 0;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) {
    out[i] = v[i] - mean;
    ss += out[i] * out[i];
  }
  const sd = Math.sqrt(ss);
  if (sd < 1e-3) return null;
  for (let i = 0; i < out.length; i++) out[i] /= sd;
  return out;
}

/** Image bytes from a data URI, or null. */
export function dataUriBytes(uri: string | null | undefined): Buffer | null {
  if (!uri?.startsWith("data:image")) return null;
  return Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64");
}

export async function bestSimilarity(photo: Buffer, thumbDataUri: string | null): Promise<number | null> {
  const thumb = dataUriBytes(thumbDataUri);
  if (!thumb) return null;
  const tm = await sharp(thumb).metadata();
  if (!tm.width || !tm.height || tm.width < 16 || tm.height < 16) return null;

  const pm = await sharp(photo).metadata();
  // After rotate() width and height may be swapped (EXIF orientation 5-8).
  const swap = (pm.orientation ?? 1) >= 5;
  const pw0 = swap ? pm.height! : pm.width!;
  const ph0 = swap ? pm.width! : pm.height!;
  const PW = PHOTO_W;
  const PH = Math.max(8, Math.round((PHOTO_W * ph0) / pw0));
  const img = await gray(photo, PW, PH);

  const ratio = tm.width / tm.height;
  const fitW = Math.min(PW, PH * ratio);
  let best = -1;
  for (const s of SCALES) {
    const tw = Math.round(fitW * s);
    const th = Math.round(tw / ratio);
    if (tw < 12 || th < 12 || tw > PW || th > PH) continue;
    const t = normalize(await gray(thumb, tw, th));
    if (!t) continue;
    const win = new Float32Array(tw * th);
    for (let y = 0; y + th <= PH; y += STRIDE) {
      for (let x = 0; x + tw <= PW; x += STRIDE) {
        for (let j = 0; j < th; j++) win.set(img.subarray((y + j) * PW + x, (y + j) * PW + x + tw), j * tw);
        const w = normalize(win);
        if (!w) continue;
        let dot = 0;
        for (let i = 0; i < w.length; i++) dot += w[i] * t[i];
        if (dot > best) best = dot;
      }
    }
  }
  return best < 0 ? 0 : Math.round(best * 100);
}
