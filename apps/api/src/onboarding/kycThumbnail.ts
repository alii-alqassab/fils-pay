import sharp from "sharp";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
/** About 50 megapixels: larger than any phone camera photo of an ID document. */
export const MAX_INPUT_PIXELS = 50_000_000;
const MAX_CONCURRENT_THUMBNAILS = 2;
let active = 0;
const waiting: Array<() => void> = [];

async function acquireSlot(): Promise<() => void> {
  if (active >= MAX_CONCURRENT_THUMBNAILS) await new Promise<void>((resolve) => waiting.push(resolve));
  else active += 1;
  return () => {
    const next = waiting.shift();
    if (next) next();
    else active -= 1;
  };
}

export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // The 8 MiB upload cap bounds the compressed file, not the decoded image: a tiny PNG can decode to
  // hundreds of megapixels. Refuse anything above a phone-camera-sized photo and decode at most a few
  // images at a time, so repeated uploads cannot exhaust memory/CPU on a small server.
  const release = await acquireSlot();
  try {
    const resized = await sharp(buffer, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" })
      .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
    return { buffer: resized, mimeType: "image/jpeg" };
  } finally {
    release();
  }
}
