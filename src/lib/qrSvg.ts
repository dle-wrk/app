// A QR code as an SVG, for printed labels. Uses the QR encoder in
// @zxing/library (already the scan page's barcode reader), so there is no
// extra package. Kept in its own module: it is loaded only when labels with a
// QR code are printed.

import { QRCodeEncoder, QRCodeDecoderErrorCorrectionLevel, EncodeHintType } from '@zxing/library';

/** The text as a QR code, error correction M (about 15% of the code can be scuffed), with a 2-module quiet zone. */
export function qrSvg(text: string): string {
  const hints = new Map<EncodeHintType, any>([[EncodeHintType.CHARACTER_SET, 'UTF-8']]);
  const m = QRCodeEncoder.encode(text, QRCodeDecoderErrorCorrectionLevel.M, hints).getMatrix();
  const n = m.getWidth();
  const q = 2;
  let d = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (m.get(x, y) !== 1) continue;
      // Runs of dark modules on a row become one rectangle.
      let w = 1;
      while (x + w < n && m.get(x + w, y) === 1) w++;
      d += `M${x + q} ${y + q}h${w}v1h-${w}z`;
      x += w - 1;
    }
  }
  const size = n + 2 * q;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" preserveAspectRatio="xMinYMin meet"><rect width="${size}" height="${size}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}
