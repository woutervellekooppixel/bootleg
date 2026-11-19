import exifReader from "exif-reader";
import sharp from "sharp";

/**
 * EXIF date taken (ms), or null. EXIF has no time zone; the clock time is read as UTC,
 * which is precise enough for ordering shoots by day.
 */
export async function dateTaken(bytes: Buffer): Promise<number | null> {
  try {
    const { exif } = await sharp(bytes).metadata();
    if (!exif) return null;
    const tags = exifReader(exif);
    const d = tags.Photo?.DateTimeOriginal ?? tags.Photo?.DateTimeDigitized ?? null;
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : null;
  } catch {
    return null;
  }
}
