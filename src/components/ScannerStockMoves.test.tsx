import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ScannerStockMoves, moveQuery, movesCsv, type StockMove } from './bookkeeping/ScannerStockMoves';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const move = (id: number, over: Partial<StockMove> = {}): StockMove => ({
  id, status: 'APPROVED', direction: 'IN', partNumber: `CAP-${id}`, itemName: 'Cap', quantity: 10, stockAfter: 50,
  location: null, lot: null, dateCode: null, reference: null, note: null,
  user: { id: 1, name: 'Sam', email: 's@example.test' }, capturedAt: null, createdAt: '2026-11-10T08:00:00Z',
  decidedBy: 'Dylan', decidedAt: '2026-11-10T09:00:00Z', rejectReason: null, ...over,
});

const EMPTY = { status: '', direction: '', part: '', user: '', decidedBy: '', from: '', to: '' };

describe('the scan list queries', () => {
  it('asks for pending scans while waiting, and decided ones in History', () => {
    expect(moveQuery('waiting', { ...EMPTY, decidedBy: 'x' }, 1)).toBe('/api/stock-moves?page=1&pageSize=30&status=PENDING');
    expect(moveQuery('history', EMPTY, 2)).toBe('/api/stock-moves?page=2&pageSize=100&status=DONE');
    expect(moveQuery('history', { ...EMPTY, status: 'REJECTED', part: ' cap ', decidedBy: 'Dyl' }, 1))
      .toBe('/api/stock-moves?page=1&pageSize=100&status=REJECTED&part=cap&decidedBy=Dyl');
  });
});

describe('the history CSV', () => {
  it('has a row per scan, quotes commas and keeps formulas as text', () => {
    const csv = movesCsv([move(1, { reference: 'PO-1, line 2', note: '=SUM(A1)', status: 'REJECTED', rejectReason: 'Wrong reel', stockAfter: null })]);
    const [head, row] = csv.trim().split('\r\n');
    expect(head.split(',')[0]).toBe('Scanned');
    expect(row).toContain('"PO-1, line 2"');
    expect(row).toContain("'=SUM(A1)");
    expect(row).toContain('REJECTED,Dylan');
    expect(row.endsWith('Wrong reel')).toBe(true);
  });
});

describe('the scanner list', () => {
  let host: HTMLDivElement; let root: Root; let asked: string[];
  beforeEach(() => {
    asked = [];
    localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      asked.push(url);
      const history = url.includes('status=DONE');
      const items = history
        ? [move(3, { createdAt: '2026-11-12T08:00:00Z' }), move(2, { direction: 'OUT', quantity: 4, createdAt: '2026-11-02T08:00:00Z' }), move(1, { status: 'REJECTED', createdAt: '2026-10-20T08:00:00Z' })]
        : [move(9, { status: 'PENDING', decidedBy: null, decidedAt: null, reference: 'PO-2026-0031', po: { id: 7, number: 'PO-2026-0031', itemId: 11 } }),
           move(8, { status: 'PENDING', direction: 'OUT', decidedBy: null, decidedAt: null, reference: 'Kit TCU06', kit: { id: 4, name: 'TCU06' } })];
      return { ok: true, json: async () => ({ items, total: items.length, pending: 1 }) } as any;
    }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  });
  afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(300); });

  it('opens on the waiting scans, and History shows the decided ones by month', async () => {
    await act(async () => { root.render(<ScannerStockMoves triggerToast={() => {}} refresh={async () => {}} />); });
    await settle();
    expect(asked.at(-1)).toContain('status=PENDING');
    expect(host.textContent).toContain('CAP-9');
    expect(host.textContent).toContain('Approve');
    // The order or kit a scan belongs to shows as a chip, not repeated as the reference.
    expect(host.textContent).toContain('PO-2026-0031');
    expect(host.textContent!.split('PO-2026-0031').length - 1).toBe(1);
    expect(host.textContent).toContain('Kit TCU06');

    await act(async () => { [...host.querySelectorAll('[role="tab"]')].find(b => b.textContent === 'History')!.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await settle();
    expect(asked.at(-1)).toContain('status=DONE');
    const months = [...host.querySelectorAll('tr[aria-expanded]')];
    expect(months.map(m => m.textContent)).toEqual([expect.stringContaining('November 2026'), expect.stringContaining('October 2026')]);
    // November: +10 in and −4 out approved; the newest month is open, October folded.
    expect(months[0].textContent).toContain('+10');
    expect(months[0].textContent).toContain('−4');
    expect(host.textContent).toContain('CAP-3');
    expect(host.textContent).not.toContain('CAP-1');
    expect([...host.querySelectorAll('button')].some(b => b.textContent === 'Approve')).toBe(false);
    expect(host.textContent).toContain('Download CSV');
    // An approved book-in can have its reel label printed; a book-out or a rejected scan can't.
    expect(host.querySelectorAll('[aria-label^="Print a reel label"]').length).toBe(1);
  });
});
