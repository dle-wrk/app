import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128Values, code128Widths, code128Svg } from './code128';
import { readScan, labelPayload, labelsHtml } from './stockLabels';

/** Reads widths back to text the way a scanner does: patterns to values, checksum checked. */
function decode(widths: number[]): string {
  const values: number[] = [];
  for (let i = 0; i < widths.length; i += 6) {
    const rest = widths.slice(i).join('');
    const v = rest === CODE128_PATTERNS[106] ? 106 : CODE128_PATTERNS.indexOf(widths.slice(i, i + 6).join(''));
    if (v < 0) throw new Error(`no pattern at ${i}`);
    values.push(v);
    if (v === 106) break;
  }
  const [start, ...rest] = values;
  expect(start).toBe(104);
  expect(rest.pop()).toBe(106);
  const check = rest.pop()!;
  expect(rest.reduce((s, v, i) => s + v * (i + 1), 104) % 103).toBe(check);
  return rest.map((v) => String.fromCharCode(v + 32)).join('');
}

describe('Code 128', () => {
  it('has the 107 patterns, each 11 modules wide (the stop 13)', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.forEach((p, i) => expect([...p].reduce((s, d) => s + Number(d), 0)).toBe(i === 106 ? 13 : 11));
  });

  it('checksums as the standard says', () => {
    // Start B 104 + A(33)·1 + B(34)·2 + C(35)·3 = 310; 310 mod 103 = 1
    expect(code128Values('ABC')).toEqual([104, 33, 34, 35, 1, 106]);
  });

  it('reads back as what was encoded', () => {
    for (const t of ['ANT-001', 'LOC:CAP-024', 'LED-010', 'a1 b/2', 'RES-020']) expect(decode(code128Widths(t))).toBe(t);
  });

  it('draws one bar per pattern bar', () => {
    const svg = code128Svg('ANT-001');
    expect(svg.match(/<rect x=/g)).toHaveLength((7 + 3) * 3 + 1); // 3 bars per symbol, 4 on the stop
    expect(svg).toContain('aria-label="Barcode ANT-001"');
  });
});

describe('labels and scans', () => {
  it('a bin label says LOC:, so a bin named after its item is still a bin', () => {
    expect(labelPayload({ kind: 'bin', code: 'ANT-001' })).toBe('LOC:ANT-001');
    expect(labelPayload({ kind: 'item', code: 'ANT-001' })).toBe('ANT-001');
    expect(readScan('LOC:ANT-001')).toEqual({ kind: 'bin', code: 'ANT-001' });
    expect(readScan(' loc:a1-03 ')).toEqual({ kind: 'bin', code: 'A1-03' });
    expect(readScan('ANT-001')).toEqual({ kind: 'code', code: 'ANT-001' });
    expect(readScan('  ')).toBeNull();
    expect(readScan('LOC:')).toBeNull();
  });

  it('prints each label with its code, name and barcode, names escaped', () => {
    const html = labelsHtml([{ kind: 'bin', code: 'A1-03', title: 'Shelf <top>' }, { kind: 'item', code: 'CAP-024', title: '100NF' }]);
    expect(html.match(/class="label"/g)).toHaveLength(2);
    expect(html).toContain('Shelf &lt;top&gt;');
    expect(html).toContain('Barcode LOC:A1-03');
    expect(html).toContain('Barcode CAP-024');
    expect(html).not.toContain('<script');
  });
});
