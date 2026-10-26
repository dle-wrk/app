import { describe, expect, it } from 'vitest';
import { linkFixFor, supplierLink, titleSupplier } from './linkCleanup';
import { capacitance, checkItem, editDistance, resistance, yageoValue } from './dataChecks';

const slots = (web: string[], sup: string[] = [], extra: Record<string, unknown> = {}) => ({
  serial_number: 'X', ...extra,
  ...Object.fromEntries([0, 1, 2, 3, 4].flatMap((i) => [[`weblink_${i + 1}`, web[i] ?? 'N/A'], [`sup_pn_${i + 1}`, sup[i] ?? 'N/A']])),
});

describe('web links that are page titles, part numbers or names (26 Oct 2026)', () => {
  it('clears a title copying a link the item already has (CAP-018)', () => {
    const f = linkFixFor(slots(['N/A', 'N/A', 'https://www.lcsc.com/product-detail/C22383709.html', 'GVU1V107M0609CN | ACMECON | PRICE | IN STOCK | LCSC ELECTRONICS'], ['N/A', 'N/A', 'C22383709']));
    expect(f?.changes).toEqual([{ field: 'weblink_4', from: 'GVU1V107M0609CN | ACMECON | PRICE | IN STOCK | LCSC ELECTRONICS', to: 'N/A' }]);
  });

  it("makes each supplier's page from the item's own numbers (ESD-007)", () => {
    const f = linkFixFor(slots(
      ['TPD4E001DCKR TEXAS INSTRUMENTS | MOUSER SOUTH AFRICA', 'TPD4E001DCKR TEXAS INSTRUMENTS | CIRCUIT PROTECTION | DIGIKEY', 'TPD4E001DCKR-TP TECH PUBLIC | LCSC ELECTRONICS'],
      ['595-TPD4E001DCKR', '296-28779-2-ND', 'C2827639']));
    expect(f?.changes.map((c) => [c.field, c.to])).toEqual([
      ['weblink_1', 'https://www.mouser.co.za/ProductDetail/595-TPD4E001DCKR'],
      ['weblink_2', 'https://www.digikey.co.za/en/products/result?keywords=296-28779-2-ND'],
      ['weblink_3', 'https://www.lcsc.com/product-detail/C2827639.html'],
    ]);
  });

  it("moves a title or a part number to the supplier's own slot (CAP-041, DIO-009)", () => {
    expect(linkFixFor(slots(['https://mouser/x', 'N/A', 'https://lcsc/x', 'CC0402KRX7R7BB104 YAGEO | CERAMIC CAPACITORS | DIGIKEY'], ['603-CC402KRX7R7BB104', '311-1338-6-ND', 'C60474']))?.changes.map((c) => [c.field, c.to]))
      .toEqual([['weblink_2', 'https://www.digikey.co.za/en/products/result?keywords=311-1338-6-ND'], ['weblink_4', 'N/A']]);
    expect(linkFixFor(slots(['N/A', 'https://dk/x', 'https://lcsc/x', '511-STPS40L45CG'], ['511-STPS40L45CG']))?.changes.map((c) => [c.field, c.to]))
      .toEqual([['weblink_1', 'https://www.mouser.co.za/ProductDetail/511-STPS40L45CG'], ['weblink_4', 'N/A']]);
  });

  it("moves a supplier's name to an empty Supplier field (PCB-001), and leaves what it can't place", () => {
    expect(linkFixFor(slots(['N/A', 'N/A', 'N/A', 'CET CIRCUITS'], [], { supplier: '' }))).toMatchObject({ supplier: 'CET CIRCUITS', changes: [{ field: 'weblink_4', to: 'N/A' }] });
    const f = linkFixFor(slots(['MOUSER PAGE TITLE | MOUSER SOUTH AFRICA'], []));
    expect(f?.changes).toEqual([]);
    expect(f?.why).toContain('needs a person: no Mouser part number');
    expect(linkFixFor(slots(['https://x', 'N/A']))).toBeNull();
  });

  it('reads whose a title is, and builds each page', () => {
    expect([titleSupplier('X | MOUSER SOUTH AFRICA'), titleSupplier('X | DIGI-KEY'), titleSupplier('X | LCSC ELECTRONICS'), titleSupplier('CET CIRCUITS')]).toEqual(['mouser', 'digikey', 'lcsc', null]);
    expect(supplierLink('lcsc', 'c60474')).toBe('https://www.lcsc.com/product-detail/C60474.html');
  });
});

describe('item data that disagrees with itself', () => {
  it('reads values from names, descriptions and Yageo part numbers', () => {
    expect([capacitance('10UF'), capacitance('CAP CER 0.1UF 16V X7R 0402'), capacitance('2U2F'), capacitance('100NF')]).toEqual([10e6, 1e5, 2.2e6, 1e5]);
    expect([resistance('1K5'), resistance('RES 1.5K OHM 1% 1/16W 0402'), resistance('100R'), resistance('49,9R'), resistance('25 MOHMS 3W')]).toEqual([1500, 1500, 100, 49.9, null]);
    expect([yageoValue('CC0402KRX7R7BB104'), yageoValue('CC0603KRX7R9BB101'), yageoValue('RC0402FR-0710KL'), yageoValue('RC0603FR-074K7L'), yageoValue('RC0402FR-07100RL')])
      .toEqual([{ kind: 'cap', value: 1e5 }, { kind: 'cap', value: 100 }, { kind: 'res', value: 1e4 }, { kind: 'res', value: 4700 }, { kind: 'res', value: 100 }]);
  });

  it('flags the real ones found on 26 Oct: CAP-041, RES-076, BUZ-001, CAP-017, CAB-014', () => {
    expect(checkItem({ serial_number: 'CAP-041', name: '10UF', description: 'CAP CER 0.1UF 16V X7R 0402', man_pn_1: 'CC0402KRX7R7BB104' }).map((c) => c.kind)).toEqual(['value', 'value']);
    expect(checkItem({ serial_number: 'RES-076', name: '100K', description: '100K 0402', man_pn_1: 'RC0402FR-0710KL' }).map((c) => c.detail)).toEqual(['RC0402FR-0710KL is 10K, but the item is 100K (named 100K).']);
    expect(checkItem({ serial_number: 'BUZ-001', name: 'BUZZER', sup_pn_3: 'C7496512', weblink_3: 'https://www.lcsc.com/product-detail/C482354.html' }).map((c) => c.kind)).toEqual(['lcsc_link']);
    expect(checkItem({ serial_number: 'CAP-017', name: '100UF', sup_pn_1: '581-AEF1012101M080R', man_pn_4: '581-AEK1012101M080R', man_pn_1: 'AEF1012101M080R' }).map((c) => c.kind)).toEqual(['two_numbers']);
    expect(checkItem({ serial_number: 'CAB-014', name: 'CAT5E', sup_pn_1: '534-2993', man_pn_1: '2993' }).map((c) => c.kind)).toEqual(['wrong_slot_value']);
  });

  it("doesn't flag what is fine: matching values, alternates, a copy of the manufacturer number", () => {
    expect(checkItem({ serial_number: 'RES-079', name: '10K', description: 'RES 10K OHM 1% 1/16W 0402', man_pn_1: 'RC0402FR-0710KL' })).toEqual([]);
    expect(checkItem({ serial_number: 'CAP-011', name: '2U2F', sup_pn_1: '791-0805B225K250CT', man_pn_4: '187-CL21B225KAFNNNE' })).toEqual([]); // two makers: alternates
    expect(checkItem({ serial_number: 'IND-009', name: '10UH', sup_pn_1: 'SRR1210-100M', man_pn_1: 'SRR1210-100M' })).toEqual([]);
    expect(editDistance('581-AEF1012101M080R', '581-AEK1012101M080R')).toBe(1);
  });
});
