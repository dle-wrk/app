// Code 128 (set B) barcodes as SVG, for bin and item labels. No library: the
// symbology is a table of bar/space widths, a start code, a checksum and a
// stop code. Set B covers printable ASCII, which is every stock and location
// code. Any ordinary barcode scanner reads it and types the code as keys.

// Bar, space, bar, space, bar, space widths for each value (stop has a 7th bar).
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];
export const CODE128_PATTERNS: readonly string[] = PATTERNS;
const START_B = 104;
const STOP = 106;
const QUIET = 10; // modules of white either side

/** The values a text encodes to in set B, with start, checksum and stop. Characters outside printable ASCII are dropped. */
export function code128Values(text: string): number[] {
  const data = [...text].map((ch) => ch.charCodeAt(0) - 32).filter((v) => v >= 0 && v <= 95);
  const check = data.reduce((sum, v, i) => sum + v * (i + 1), START_B) % 103;
  return [START_B, ...data, check, STOP];
}

/** The widths of every bar and space, in modules, starting with a bar. */
export function code128Widths(text: string): number[] {
  return code128Values(text).flatMap((v) => [...PATTERNS[v]].map(Number));
}

/** An SVG of the barcode, `height` in modules tall; it scales to the width it is given. */
export function code128Svg(text: string, height = 40): string {
  const widths = code128Widths(text);
  const total = widths.reduce((a, b) => a + b, 0) + QUIET * 2;
  let x = QUIET; let rects = '';
  widths.forEach((w, i) => {
    if (i % 2 === 0) rects += `<rect x="${x}" y="0" width="${w}" height="${height}"/>`;
    x += w;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" preserveAspectRatio="none" shape-rendering="crispEdges" role="img" aria-label="Barcode ${text.replace(/[&<>"]/g, '')}"><rect width="${total}" height="${height}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}
