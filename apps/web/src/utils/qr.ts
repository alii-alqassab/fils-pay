import qrcode from "qrcode-generator";

/** Blank modules required around a QR code by the spec; scanners need them. */
export const QR_QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  isDark(row: number, col: number): boolean;
}

/**
 * Encodes `text` as a QR code. Error correction is "Q" (~25% recoverable) so
 * a code still scans when shown on a dirty screen or printed small. Throws if
 * the text is empty or too long for the largest QR version.
 */
export function buildQr(text: string): QrMatrix {
  if (text.length === 0) throw new Error("Cannot build a QR code for empty text.");
  const qr = qrcode(0, "Q");
  qr.addData(text, "Byte");
  qr.make();
  return { size: qr.getModuleCount(), isDark: (row, col) => qr.isDark(row, col) };
}

/** Side length of the drawing in modules, quiet zone included. */
export function qrViewSize(matrix: QrMatrix): number {
  return matrix.size + QR_QUIET_ZONE * 2;
}

/**
 * One SVG path for every dark module, as horizontal runs per row. The quiet
 * zone is already applied to the coordinates, so draw it on a light square
 * of `qrViewSize` modules.
 */
export function qrPath(matrix: QrMatrix): string {
  const parts: string[] = [];
  for (let row = 0; row < matrix.size; row += 1) {
    let col = 0;
    while (col < matrix.size) {
      if (!matrix.isDark(row, col)) {
        col += 1;
        continue;
      }
      const start = col;
      while (col < matrix.size && matrix.isDark(row, col)) col += 1;
      parts.push(`M${start + QR_QUIET_ZONE} ${row + QR_QUIET_ZONE}h${col - start}v1h-${col - start}z`);
    }
  }
  return parts.join("");
}

/**
 * Renders the QR code to a PNG: black on white, quiet zone included. The
 * module size is a whole number of pixels so edges stay sharp, which means
 * the result is at most `targetPx` wide rather than exactly that.
 */
export function qrToPngBlob(matrix: QrMatrix, targetPx = 1024): Promise<Blob> {
  const modules = qrViewSize(matrix);
  const cell = Math.max(1, Math.floor(targetPx / modules));
  const canvas = document.createElement("canvas");
  canvas.width = modules * cell;
  canvas.height = modules * cell;
  const context = canvas.getContext("2d");
  if (!context) return Promise.reject(new Error("Canvas is not available."));

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#000000";
  for (let row = 0; row < matrix.size; row += 1) {
    for (let col = 0; col < matrix.size; col += 1) {
      if (matrix.isDark(row, col)) {
        context.fillRect((col + QR_QUIET_ZONE) * cell, (row + QR_QUIET_ZONE) * cell, cell, cell);
      }
    }
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Could not create the image."))), "image/png");
  });
}
