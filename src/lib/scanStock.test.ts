import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { barcodesIn, isPlaceholder, kitPickList, movementReference, parseDecision, parseMoveFields, parseMoveListQuery, parseScannedCode, poStatusAfter } from './scanStock';
import { reelPayload, readReel, readBin } from './reelLabel';
import { readScan } from './stockLabels';
import { permissionForWrite } from './writeAccess';
import { roleCan } from './permissions';

const GS = '\x1d', RS = '\x1e', EOT = '\x04';
const NOW = Date.parse('2026-11-17T10:00:00Z');

describe('reading a scanned code', () => {
  it('reads a supplier reel label (2D code): maker part first, then the supplier part, with quantity, lot and date code', () => {
    const label = `[)>${RS}06${GS}P296-1234-1-ND${GS}1PCL10A106KP8NNNC${GS}K${GS}1K61234567${GS}10K7654321${GS}9D2535${GS}1TLOT778899${GS}11K1${GS}4LKR${GS}Q4000${GS}11ZPICK${RS}${EOT}`;
    expect(parseScannedCode(label)).toEqual({
      candidates: ['CL10A106KP8NNNC', '296-1234-1-ND'], quantity: 4000, lot: 'LOT778899', dateCode: '2535', kind: 'supplier-2d',
    });
  });

  it('prefers the supplier\'s own number tag (30P) over the customer part tag (P)', () => {
    expect(parseScannedCode(`[)>${RS}06${GS}PCUST-REF${GS}30P511-STM32F103${GS}1PSTM32F103C8T6${GS}Q250`).candidates).toEqual(['STM32F103C8T6', '511-STM32F103']);
  });

  it('reads an LCSC / JLCPCB bag QR code', () => {
    expect(parseScannedCode('{pbn:PICK2009291337,on:SO2009291337,pc:C2040,pm:STM32F103C8T6,qty:10,mc:,cc:1,pdi:34421807}'))
      .toEqual({ candidates: ['STM32F103C8T6', 'C2040'], quantity: 10, lot: null, dateCode: null, kind: 'supplier-qr' });
  });

  it('takes anything else as typed text: a stock code, a part number or a location code', () => {
    expect(parseScannedCode('  cap-024 ')).toEqual({ candidates: ['cap-024'], quantity: null, lot: null, dateCode: null, kind: 'text' });
    expect(parseScannedCode('{not a label}').kind).toBe('text');
    expect(parseScannedCode('').candidates).toEqual([]);
    expect(parseScannedCode(`[)>${RS}06${GS}Qabc`).quantity).toBeNull();
  });
});

describe('placeholders for a missing part number', () => {
  it('are not used to find an item', () => {
    expect(['N/A', 'na', ' - ', 'TBD', '??', 'XX', 'none'].map(isPlaceholder)).toEqual([true, true, true, true, true, true, true]);
    expect(['C2040', 'CL10A106KP8NNNC', '296-1234-1-ND', 'NAND'].map(isPlaceholder)).toEqual([false, false, false, false]);
  });
});

describe('a booking from the phone', () => {
  const base = { direction: 'in', partNumber: ' CAP-024 ', quantity: '4000' };

  it('is tidied', () => {
    expect(parseMoveFields({ ...base, locationId: '3', lot: ' L1 ', dateCode: '2535', reference: ' PO-2026-0007 ', note: '', clientRef: 'phone-1:abc12345', capturedAt: '2026-11-17T09:00:00Z' }, NOW))
      .toEqual({ direction: 'IN', partNumber: 'CAP-024', quantity: 4000, locationId: 3, lot: 'L1', dateCode: '2535', reference: 'PO-2026-0007', note: null, capturedAt: '2026-11-17T09:00:00.000Z', clientRef: 'phone-1:abc12345', newItem: null, linkCodes: [], poItemId: null, kitId: null });
    expect(parseMoveFields({ ...base, direction: 'OUT' }, NOW)).toMatchObject({ direction: 'OUT', locationId: null, lot: null });
  });

  it('says what is wrong, as a 400', () => {
    expect(() => parseMoveFields({ ...base, direction: 'sideways' })).toThrow('IN or OUT');
    expect(() => parseMoveFields({ ...base, partNumber: '' })).toThrow('item first');
    for (const quantity of ['', '0', '-5', '2.5', 'ten', '1e9']) expect(() => parseMoveFields({ ...base, quantity })).toThrow(/quantity/i);
    expect(() => parseMoveFields({ ...base, locationId: 'A1' })).toThrow('location');
    expect(() => parseMoveFields({ ...base, direction: 'OUT', lot: 'L1' })).toThrow('only recorded when booking in');
    expect(() => parseMoveFields({ ...base, clientRef: 'short' })).toThrow('clientRef');
    try { parseMoveFields({}); } catch (e: any) { expect(e.status).toBe(400); }
  });

  it('can bring in a new item from an unknown label, with the label\'s codes to remember', () => {
    const label = `[)>${RS}06${GS}P296-1234-1-ND${GS}1PCL10A106KP8NNNC${GS}Q4000`;
    const f = parseMoveFields({ direction: 'in', quantity: '4000', code: label, newItem: { partNumber: ' cap 099 ', name: ' 10uF  0603 ', makerPartNumber: 'CL10A106KP8NNNC' } }, NOW);
    expect(f).toMatchObject({ partNumber: 'CAP-099', newItem: { partNumber: 'CAP-099', name: '10uF 0603', description: null, makerPartNumber: 'CL10A106KP8NNNC' }, linkCodes: ['CL10A106KP8NNNC', '296-1234-1-ND'] });
    expect(parseMoveFields({ direction: 'in', quantity: '1', newItem: { partNumber: 'X1', name: 'Thing', makerPartNumber: 'N/A' } }, NOW).newItem?.makerPartNumber).toBeNull();
    expect(() => parseMoveFields({ direction: 'out', quantity: '1', newItem: { partNumber: 'CAP-099', name: 'x' } })).toThrow('only be booked in');
    expect(() => parseMoveFields({ direction: 'in', quantity: '1', newItem: { partNumber: '?', name: 'x' } })).toThrow('stock code');
    expect(() => parseMoveFields({ direction: 'in', quantity: '1', newItem: { partNumber: 'CAP-099', name: ' ' } })).toThrow('name');
  });

  it('links a label to an existing item only when asked, and never as its own stock code', () => {
    expect(parseMoveFields({ ...base, code: '5012345678900', saveBarcode: true }, NOW).linkCodes).toEqual(['5012345678900']);
    expect(parseMoveFields({ ...base, code: '5012345678900' }, NOW).linkCodes).toEqual([]);
    expect(parseMoveFields({ ...base, code: 'cap-024', saveBarcode: true }, NOW).linkCodes).toEqual([]);
    expect(barcodesIn('{pc:C2040,pm:N/A,qty:5}')).toEqual(['C2040']);
  });

  it('writes a reference the item history can be read by', () => {
    expect(movementReference({ direction: 'IN', reference: 'PO-2026-0007', note: null }, 'A1-03')).toBe('Scanner: PO-2026-0007 @ A1-03');
    expect(movementReference({ direction: 'OUT', reference: null, note: 'for the bench' }, null)).toBe('Scanner: for the bench');
    expect(movementReference({ direction: 'OUT', reference: null, note: null }, null)).toBe('Scanner: book out');
  });

  it('needs the inventory permission, like changing stock on the website', () => {
    expect(permissionForWrite('POST', '/api/stock-moves')).toBe('inventory.update');
    expect(permissionForWrite('GET', '/api/stock-moves/find')).toBeNull();
    expect(roleCan('viewer', 'inventory.update')).toBe(false);
  });
});

describe('listing scanner bookings', () => {
  it('reads the filters', () => {
    expect(parseMoveListQuery({ direction: 'out', part: ' cap ', from: '2026-11-01', to: 'x', page: '2', pageSize: '999' }))
      .toEqual({ page: 2, pageSize: 100, status: null, mine: false, direction: 'OUT', part: 'cap', user: null, decidedBy: null, from: '2026-11-01', to: null });
    expect(parseMoveListQuery({ status: 'done', decidedBy: ' Sam ' })).toMatchObject({ status: 'DONE', decidedBy: 'Sam' });
    expect(parseMoveListQuery({ status: 'pending', mine: '1' })).toMatchObject({ status: 'PENDING', mine: true });
    expect(parseMoveListQuery({ status: 'maybe' }).status).toBeNull();
    expect(parseMoveListQuery({ direction: 'both' }).direction).toBeNull();
  });
});

describe('approving or rejecting scans', () => {
  it('reads which scans and what to do with them', () => {
    expect(parseDecision({ ids: [3, '4', 3, 'x', -1], decision: 'approve' })).toEqual({ ids: [3, 4], decision: 'APPROVE', reason: null });
    expect(parseDecision({ ids: [7], decision: 'REJECT', reason: '  wrong reel ' })).toEqual({ ids: [7], decision: 'REJECT', reason: 'wrong reel' });
  });

  it('refuses a request that names no scan or no decision', () => {
    expect(() => parseDecision({ ids: [1], decision: 'maybe' })).toThrow('APPROVE or REJECT');
    expect(() => parseDecision({ ids: [], decision: 'APPROVE' })).toThrow('at least one');
    expect(() => parseDecision({ ids: 'all', decision: 'APPROVE' })).toThrow('at least one');
    expect(() => parseDecision({ ids: Array.from({ length: 201 }, (_, i) => i + 1), decision: 'APPROVE' })).toThrow('200');
  });
});
describe("Tracklab's own labels", () => {
  it('reads a reel label back as it was printed', () => {
    const p = reelPayload({ code: 'CAP-024', lot: 'L 24/31', dateCode: '2431', qty: 5000, place: 'A1-03' });
    expect(p.startsWith('TL:CAP-024?')).toBe(true);
    expect(/^[ -~]+$/.test(p)).toBe(true); // plain ASCII: a keyboard scanner types it as is
    expect(readReel(p)).toEqual({ code: 'CAP-024', lot: 'L 24/31', dateCode: '2431', qty: 5000, place: 'A1-03' });
    expect(readReel(reelPayload({ code: 'PCB/V2' }))).toEqual({ code: 'PCB/V2', lot: null, dateCode: null, qty: null, place: null });
    expect(readReel('CAP-024')).toBeNull();
    expect(readReel('TL:')).toBeNull();
  });

  it('the scanner reads a reel label: the item, its quantity, lot, date code and place', () => {
    const r = parseScannedCode(reelPayload({ code: 'CAP-024', lot: 'L1', dateCode: '2431', qty: 400, place: 'a1-03' }));
    expect(r).toMatchObject({ kind: 'tracklab', candidates: ['CAP-024'], quantity: 400, lot: 'L1', dateCode: '2431', place: 'A1-03' });
  });

  it('the scanner reads a bin label as a place, not an item', () => {
    expect(readBin(' loc:a1 03 ')).toBe('A1-03');
    expect(parseScannedCode('LOC:A1-03')).toMatchObject({ kind: 'place', candidates: [], place: 'A1-03' });
    expect(barcodesIn('LOC:A1-03')).toEqual([]);
  });

  it('the web scan page takes a reel label as its item', () => {
    expect(readScan(reelPayload({ code: 'RES-1K', qty: 10 }))).toEqual({ kind: 'code', code: 'RES-1K' });
  });
});

describe('receiving on a purchase order, picking for a kit', () => {
  it('takes a PO line on a book-in and a kit on a book-out, only', () => {
    expect(parseMoveFields({ direction: 'IN', partNumber: 'A', quantity: 1, poItemId: 12 }, NOW).poItemId).toBe(12);
    expect(parseMoveFields({ direction: 'OUT', partNumber: 'A', quantity: 1, kitId: '7' }, NOW).kitId).toBe(7);
    expect(parseMoveFields({ direction: 'IN', partNumber: 'A', quantity: 1 }, NOW)).toMatchObject({ poItemId: null, kitId: null });
    expect(() => parseMoveFields({ direction: 'OUT', partNumber: 'A', quantity: 1, poItemId: 12 }, NOW)).toThrow('booked in');
    expect(() => parseMoveFields({ direction: 'IN', partNumber: 'A', quantity: 1, kitId: 7 }, NOW)).toThrow('booked out');
    expect(() => parseMoveFields({ direction: 'IN', partNumber: 'A', quantity: 1, poItemId: -1 }, NOW)).toThrow('not valid');
  });

  it("a kit's pick list: qty per board x builds, the reels picked for a line instead of its own code, DNF left out", () => {
    const lines = kitPickList(
      [{ stock_code: 'CAP-1', qty_per_pcb: 2 }, { stock_code: 'RES-1', qty_per_pcb: 1 }, { stock_code: 'RES-1', qty_per_pcb: 3 },
       { stock_code: 'IC-1', qty_per_pcb: 1 }, { stock_code: 'DNF', qty_per_pcb: 1 }, { stock_code: 'LED-1', qty_per_pcb: 1 }],
      [{ stock_code: 'IC-1', allocated_code: 'IC-1B', qty: 6 }, { stock_code: 'IC-1', allocated_code: 'IC-1', qty: 4 }, { stock_code: 'cap-1', allocated_code: 'CAP-1', qty: 0 }],
      ['LED-1'], 10);
    expect(lines).toEqual([
      { code: 'CAP-1', need: 20, forLines: ['CAP-1'] },
      { code: 'IC-1', need: 4, forLines: ['IC-1'] },
      { code: 'IC-1B', need: 6, forLines: ['IC-1'] },
      { code: 'RES-1', need: 40, forLines: ['RES-1'] },
    ]);
  });

  it("a PO's status once stock comes in on it", () => {
    expect(poStatusAfter('SENT', [{ quantity: 10, received: 4 }, { quantity: 5, received: 0 }])).toBe('PARTIAL');
    expect(poStatusAfter('PARTIAL', [{ quantity: 10, received: 10 }, { quantity: 5, received: 6 }])).toBe('RECEIVED');
    expect(poStatusAfter('DRAFT', [{ quantity: 10, received: 0 }])).toBe('DRAFT');
    expect(poStatusAfter('CANCELLED', [{ quantity: 10, received: 10 }])).toBe('CANCELLED');
  });
});
