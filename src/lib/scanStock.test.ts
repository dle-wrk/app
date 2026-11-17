import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { isPlaceholder, movementReference, parseDecision, parseMoveFields, parseMoveListQuery, parseScannedCode } from './scanStock';
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
      .toEqual({ direction: 'IN', partNumber: 'CAP-024', quantity: 4000, locationId: 3, lot: 'L1', dateCode: '2535', reference: 'PO-2026-0007', note: null, capturedAt: '2026-11-17T09:00:00.000Z', clientRef: 'phone-1:abc12345' });
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
      .toEqual({ page: 2, pageSize: 100, status: null, mine: false, direction: 'OUT', part: 'cap', user: null, from: '2026-11-01', to: null });
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