import { describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => ({ pool: {}, query: vi.fn(), queryOne: vi.fn(), exec: vi.fn() }));

import { normaliseNumber, parseListQuery, parseScanFields, resolveLinks } from './scansRoutes';
import { sniffImageType } from './scanStorage';
import { idleLimitFor, presentedSession, SESSION_IDLE_MS, MOBILE_SESSION_IDLE_MS } from './authRoutes';
import { permissionForWrite, requireWriteAccess } from './writeAccess';

const NOW = Date.parse('2026-11-16T10:00:00Z');

describe('what the scanner app sends with a scan', () => {
  it('is tidied: spaces trimmed, decimal comma read, blanks as nothing', () => {
    expect(parseScanFields({ pickNote: '  SO-2026-0004 ', description: ' Relay   board ', quantity: '2,5', clientName: ' Acme ', clientCode: '', clientRef: 'phone-1:abc12345' }, NOW))
      .toEqual({ pickNote: 'SO-2026-0004', description: 'Relay board', quantity: 2.5, clientName: 'Acme', clientCode: null, capturedAt: null, clientRef: 'phone-1:abc12345' });
  });

  it('says what is missing or wrong, as a 400', () => {
    const base = { pickNote: 'SO-1', description: 'Board', quantity: '1' };
    expect(() => parseScanFields({ ...base, pickNote: ' ' })).toThrow('pick note number');
    expect(() => parseScanFields({ ...base, description: '' })).toThrow('description or code');
    for (const quantity of ['', '0', '-3', 'ten', '1e9']) expect(() => parseScanFields({ ...base, quantity })).toThrow(/quantity/i);
    expect(() => parseScanFields({ ...base, pickNote: 'x'.repeat(61) })).toThrow('too long');
    expect(() => parseScanFields({ ...base, clientRef: 'short' })).toThrow('clientRef');
    expect(() => parseScanFields({ ...base, clientRef: "abc12345'; DROP" })).toThrow('clientRef');
    try { parseScanFields({}); } catch (e: any) { expect(e.status).toBe(400); }
  });

  it('keeps when the photo was taken for a queued scan, but not a time in the future or over a year old', () => {
    const base = { pickNote: 'SO-1', description: 'Board', quantity: '1' };
    expect(parseScanFields({ ...base, capturedAt: '2026-11-15T08:30:00+02:00' }, NOW).capturedAt).toBe('2026-11-15T06:30:00.000Z');
    expect(parseScanFields({ ...base, capturedAt: '2026-11-17T10:00:00Z' }, NOW).capturedAt).toBeNull();
    expect(parseScanFields({ ...base, capturedAt: '2024-01-01T00:00:00Z' }, NOW).capturedAt).toBeNull();
    expect(parseScanFields({ ...base, capturedAt: 'yesterday' }, NOW).capturedAt).toBeNull();
  });
});

describe('listing scans', () => {
  it('reads the filters and keeps paging within bounds', () => {
    expect(parseListQuery({ pickNote: ' SO-1 ', user: 'sam', from: '2026-11-01', to: 'tomorrow', page: '3', pageSize: '500', clientOrderId: '7', dispatchNoteId: '7; DROP' }))
      .toEqual({ page: 3, pageSize: 100, pickNote: 'SO-1', user: 'sam', client: null, from: '2026-11-01', to: null, clientOrderId: 7, dispatchNoteId: null });
    expect(parseListQuery({ page: '-2', pageSize: '0' })).toMatchObject({ page: 1, pageSize: 30 });
  });
});

describe('matching a pick note number', () => {
  const db = (order: any, note: any, clients: any[] = []) => ({
    query: vi.fn(async (sql: string, _params?: any[]) => ({
      rows: /FROM client_orders/.test(sql) ? (order ? [order] : []) : /FROM dispatch_notes/.test(sql) ? (note ? [note] : []) : clients,
    })),
  });

  it('ignores case and spaces only', () => {
    expect(normaliseNumber(' so-2026 0004 ')).toBe('SO-20260004');
  });

  it('links a sales order number to the order and its client', async () => {
    const d = db({ id: 4, order_number: 'SO-2026-0004', client_id: 9, client_name: 'Acme' }, null);
    expect(await resolveLinks(d, 'so-2026-0004', 'Someone else')).toMatchObject({ clientOrderId: 4, dispatchNoteId: null, clientId: 9, client: { id: 9, name: 'Acme' } });
    expect(d.query.mock.calls[0][1]).toEqual(['SO-2026-0004']);
  });

  it('links a delivery note number to the note, and through it to its order', async () => {
    const d = db(null, { id: 12, note_number: 'DN-2026-0012', note_type: 'DELIVERY', client_id: 9, client_order_id: 4, client_name: 'Acme' });
    expect(await resolveLinks(d, 'DN-2026-0012', null)).toMatchObject({ clientOrderId: 4, dispatchNoteId: 12, clientId: 9, dispatchNote: { number: 'DN-2026-0012', type: 'DELIVERY' }, order: null });
  });

  it('with no matching number, links the typed client only when exactly one has that name', async () => {
    expect(await resolveLinks(db(null, null, [{ id: 3, client_name: 'Acme' }]), 'PICK-77', 'acme')).toMatchObject({ clientOrderId: null, dispatchNoteId: null, clientId: 3 });
    expect(await resolveLinks(db(null, null, [{ id: 3, client_name: 'Acme' }, { id: 5, client_name: 'ACME' }]), 'PICK-77', 'acme')).toMatchObject({ clientId: null, client: null });
    expect(await resolveLinks(db(null, null), 'PICK-77', null)).toMatchObject({ clientId: null });
  });
});

describe('the photo itself', () => {
  const pad = (bytes: number[]) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);
  it('is recognised by its first bytes, not by what the phone calls it', () => {
    expect(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffImageType(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImageType(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(8)]))).toBe('image/heic');
    expect(sniffImageType(Buffer.from('<html><script>alert(1)</script></html>'))).toBeNull();
    expect(sniffImageType(Buffer.from('%PDF-1.7 ...........'))).toBeNull();
    expect(sniffImageType(Buffer.alloc(3))).toBeNull();
  });
});

describe('phone sessions', () => {
  it('last 30 idle days; web sessions keep their 24 hours', () => {
    expect(idleLimitFor('mobile')).toBe(MOBILE_SESSION_IDLE_MS);
    expect(idleLimitFor('web')).toBe(SESSION_IDLE_MS);
    expect(idleLimitFor(null)).toBe(SESSION_IDLE_MS);
    expect(MOBILE_SESSION_IDLE_MS).toBe(30 * 86_400_000);
  });

  it('reads the token from X-Session-Id first, then from a Bearer header (marked, so only phone sessions accept it)', () => {
    const token = 'ab'.repeat(24);
    expect(presentedSession({ headers: { 'x-session-id': token } })).toEqual({ id: token, bearer: false });
    expect(presentedSession({ headers: { authorization: `Bearer ${token}` } })).toEqual({ id: token, bearer: true });
    expect(presentedSession({ headers: { authorization: 'Bearer not a token' }, body: {} })).toEqual({ id: '', bearer: false });
    expect(presentedSession({ headers: {}, body: { sessionId: token } })).toEqual({ id: token, bearer: false });
  });
});

describe('who may save or delete a scan', () => {
  it('is everyone signed in except viewers', () => {
    expect(permissionForWrite('POST', '/api/scans')).toBe('staff');
    expect(permissionForWrite('DELETE', '/api/scans/4')).toBe('staff');
    expect(permissionForWrite('GET', '/api/scans')).toBeNull();
    expect(permissionForWrite('POST', '/api/mobile/login')).toBeNull();
    const attempt = (role: string) => {
      const res: any = { status: vi.fn(() => res), json: vi.fn() };
      const next = vi.fn();
      requireWriteAccess({ method: 'POST', baseUrl: '/api', path: '/scans', user: { role } }, res, next);
      return next.mock.calls.length === 1;
    };
    expect(['admin', 'manager', 'engineer', 'viewer'].map(attempt)).toEqual([true, true, true, false]);
  });
});
