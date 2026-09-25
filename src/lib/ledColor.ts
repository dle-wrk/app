// LED colour detection — scan an item's name / description for known
// LED colour keywords and hand back a swatch descriptor the UI can
// render. Shared between the Inventory cards and the Kit Booking
// allocation modal so the same rules (and the same swatch colours)
// apply everywhere the operator sees LED rows.
//
// Compound colours (YELLOW-GREEN, WARM WHITE, INFRARED, RGB, BI-COLOUR)
// are ordered before the single-word matches so the more specific one
// wins even when the shorter word is also present. Multi-colour LEDs
// (RGB, BI-COLOUR) return multiple hex codes so the UI can render a
// split-fill dot.
//
// Detection is gated on rows that actually look like LEDs (name starts
// with "LED", partNumber prefix "LED-", or an itemType containing LED)
// so a resistor whose description mentions GREEN doesn't pick up a
// spurious swatch.

export interface LedSwatch {
  label: string;
  colors: string[];
}

const LED_COLOR_TABLE: Array<{ match: RegExp; label: string; colors: string[] }> = [
  { match: /\bRGB\b/i, label: 'RGB', colors: ['#ef4444', '#22c55e', '#3b82f6'] },
  { match: /\bBI[- ]?COLOU?R\b|\bBICOLOU?R\b/i, label: 'Bi-colour', colors: ['#ef4444', '#22c55e'] },
  { match: /\bYELLOW[- ]GREEN\b/i, label: 'Yellow-green', colors: ['#a3e635'] },
  { match: /\bYELLOW[- ]ORANGE\b/i, label: 'Yellow-orange', colors: ['#fb923c'] },
  { match: /\bCOOL[- ]WHITE\b/i, label: 'Cool white', colors: ['#e0f2fe'] },
  { match: /\bWARM[- ]WHITE\b/i, label: 'Warm white', colors: ['#fef3c7'] },
  { match: /\bINFRA[- ]?RED\b|\bIR\b/i, label: 'Infrared', colors: ['#7f1d1d'] },
  { match: /\bAMBER\b/i, label: 'Amber', colors: ['#f59e0b'] },
  { match: /\bORANGE\b/i, label: 'Orange', colors: ['#f97316'] },
  { match: /\bYELLOW\b/i, label: 'Yellow', colors: ['#eab308'] },
  { match: /\bGREEN\b/i, label: 'Green', colors: ['#22c55e'] },
  { match: /\bBLUE\b/i, label: 'Blue', colors: ['#3b82f6'] },
  { match: /\bWHITE\b|\bCOLORLESS\b|\bCOLOURLESS\b/i, label: 'White', colors: ['#f8fafc'] },
  { match: /\bRED\b/i, label: 'Red', colors: ['#ef4444'] },
  { match: /\bPURPLE\b|\bVIOLET\b/i, label: 'Purple', colors: ['#a855f7'] },
  { match: /\bPINK\b/i, label: 'Pink', colors: ['#f472b6'] },
  { match: /\bUV\b|\bULTRAVIOLET\b/i, label: 'UV', colors: ['#c084fc'] },
];

// The bar for "this row is an LED". Callers pass whichever of these
// fields they have; missing fields are treated as empty strings.
export interface LedProbe {
  name?: string;
  description?: string;
  itemType?: string;
  partNumber?: string;
}

export function detectLedSwatch(item: LedProbe): LedSwatch | null {
  const pn = String(item.partNumber || '');
  const name = String(item.name || '');
  const type = String(item.itemType || '');
  const isLed = /^LED\b/i.test(name) || /^LED[- ]/i.test(pn) || /\bLED\b/i.test(type);
  if (!isLed) return null;
  const haystack = `${name} ${item.description || ''}`;
  for (const row of LED_COLOR_TABLE) {
    if (row.match.test(haystack)) return { label: row.label, colors: row.colors };
  }
  return null;
}

// CSS background for a swatch — solid colour for a single-colour LED,
// a hard-stop gradient for a multi-colour so each colour occupies an
// equal wedge. Callers apply this to an element with `background: …`.
export function ledSwatchBackground(swatch: LedSwatch): string {
  if (swatch.colors.length === 1) return swatch.colors[0];
  const stops = swatch.colors.map((c, i) => {
    const from = (i / swatch.colors.length) * 100;
    const to = ((i + 1) / swatch.colors.length) * 100;
    return `${c} ${from}%, ${c} ${to}%`;
  }).join(', ');
  return `linear-gradient(90deg, ${stops})`;
}
