import { describe, expect, it } from 'vitest';
import { BinaryBitmap, HybridBinarizer, QRCodeReader, RGBLuminanceSource } from '@zxing/library';
import { qrSvg } from './qrSvg';
import { labelsHtml } from './stockLabels';
import { reelPayload, readReel } from './reelLabel';

/** Draws the SVG's rectangles onto a grey-scale image, 6 px a module, and reads it back with ZXing's QR reader. */
function decode(svg: string): string {
  const size = Number(/viewBox="0 0 (\d+) /.exec(svg)![1]);
  const px = 6, w = size * px;
  const lum = new Uint8ClampedArray(w * w).fill(255);
  const path = /<path d="([^"]*)"/.exec(svg)![1];
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    const [x, y, run] = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let yy = y * px; yy < (y + 1) * px; yy++) for (let xx = x * px; xx < (x + run) * px; xx++) lum[yy * w + xx] = 0;
  }
  const bitmap = new BinaryBitmap(new HybridBinarizer(new RGBLuminanceSource(lum, w, w)));
  return new QRCodeReader().decode(bitmap).getText();
}

describe('QR codes on reel labels', () => {
  it('a printed reel label scans back to the same reel', () => {
    const payload = reelPayload({ code: 'CAP-024', lot: 'L2431-A', dateCode: '2431', qty: 5000, place: 'REEL-RACK-2' });
    const read = decode(qrSvg(payload));
    expect(read).toBe(payload);
    expect(readReel(read)).toEqual({ code: 'CAP-024', lot: 'L2431-A', dateCode: '2431', qty: 5000, place: 'REEL-RACK-2' });
  });

  it('a reel label shows its code, name and details, and a bin label keeps its barcode', () => {
    const html = labelsHtml([
      { kind: 'reel', code: 'CAP-024', title: '100nF <0402>', lot: 'L1', dateCode: '2431', qty: 4000, place: 'A1-03' },
      { kind: 'bin', code: 'A1-03' },
    ], () => '<svg class="fake-qr"></svg>');
    expect(html).toContain('fake-qr');
    expect(html).toContain('100nF &lt;0402&gt;');
    expect(html).toContain('Lot <b>L1</b>');
    expect(html).toContain('Qty <b>4000</b>');
    expect((html.match(/class="label/g) || []).length).toBe(2);
  });
});
