import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import PartNumberReview, { type PartNumberIssue } from './PartNumberReview';
import { ConfirmOptions, setConfirmHandler } from '../lib/confirmDialog';

// The part-number review screen against a stubbed API.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const ISSUES: PartNumberIssue[] = [
  { kind: 'supplier_name', serialNumber: 'BUT-002', name: 'BUTTON', field: 'sup_pn_1', value: 'MOUSER ELECTRONICS', fix: { action: 'move_to_supplier' }, note: 'moves' },
  { kind: 'supplier_name', serialNumber: 'BUT-002', name: 'BUTTON', field: 'sup_pn_2', value: 'DIGIKEY', fix: { action: 'clear' }, note: 'cleared' },
  { kind: 'lcsc_extra_text', serialNumber: 'DIO-015', name: 'SMCJ28CA', field: 'man_pn_3', value: 'C2943749 BD', fix: { action: 'set', value: 'C2943749' }, note: 'number only' },
  { kind: 'held_back', serialNumber: 'PCB-001', name: 'TCU PCB TCU04', field: null, value: 'TCU04', fix: null, note: 'correct it' },
  { kind: 'no_part_number', serialNumber: 'ASS-001', name: 'ASSEMBLY', field: null, value: null, fix: null, note: 'add one' },
];

let calls: Array<{ method: string; url: string; body?: any }>;
let review: { issues: PartNumberIssue[]; counts: Record<string, number>; fixable: number; canFix: boolean };
let fixReply: { status: number; body: unknown };
let confirms: ConfirmOptions[];
const toast = vi.fn();
const changed = vi.fn();
const openItem = vi.fn();
let host: HTMLDivElement;
let root: Root;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  calls = [];
  review = { issues: ISSUES, counts: { supplier_name: 2, lcsc_extra_text: 1, held_back: 1, no_part_number: 1 }, fixable: 3, canFix: true };
  fixReply = { status: 200, body: { applied: [{}], skipped: [] } };
  confirms = [];
  toast.mockClear();
  changed.mockClear();
  openItem.mockClear();
  setConfirmHandler(async (opts) => { confirms.push(opts); return true; });
  localStorage.setItem('currentUser', JSON.stringify({ email: 'engineer@example.com', role: 'engineer' }));
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (method === 'GET' && url === '/api/inventory/part-number-review') return reply(review);
    if (method === 'POST' && url === '/api/inventory/part-number-review/fix') return reply(fixReply.body, fixReply.status);
    return reply({ error: `unexpected ${method} ${url}` }, 500);
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  setConfirmHandler(null);
  localStorage.clear();
});

async function render() {
  await act(async () => { root.render(<PartNumberReview onShowNotification={toast} onOpenItem={openItem} onChanged={changed} />); });
  await settle();
}
const text = (el: Element | null) => (el?.textContent ?? '').replace(/ /g, ' ');
const buttons = (scope: ParentNode = host) => Array.from(scope.querySelectorAll('button'));
const button = (label: string, scope: ParentNode = host) => buttons(scope).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const section = (kind: string) => host.querySelector(`[data-testid="section-${kind}"]`)!;
const row = (key: string) => host.querySelector(`[data-issue="${key}"]`)!;
const posts = () => calls.filter((c) => c.method === 'POST');

describe('the part-number review', () => {
  it('groups the issues, with what to do about each', async () => {
    await render();

    expect(text(host.querySelector('[data-testid="review-summary"]'))).toBe('5 issues on 4 items; 3 can be fixed here.');
    expect(text(section('supplier_name'))).toContain('Supplier names in part-number fields2');
    expect(text(row('supplier_name|BUT-002|sup_pn_1'))).toMatch(/BUT-002BUTTONSupPN1MOUSER ELECTRONICSmovesMove to Supplier/);
    expect(button('Use C2943749')).toBeTruthy();
    // Held back: no fix button, only the item to open.
    expect(buttons(section('held_back')).map((b) => b.textContent?.trim())).toEqual(['Prices held back: the part number matched the wrong part1', 'PCB-001']);
    // "No part number" starts folded away.
    expect(section('no_part_number').querySelector('table')).toBeNull();
  });

  it('applies one fix as offered, and reloads', async () => {
    await render();

    await click(button('Use C2943749')!);

    expect(confirms).toEqual([]);
    expect(posts().map((c) => c.body)).toEqual([{ fixes: [{ serialNumber: 'DIO-015', field: 'man_pn_3', action: 'set', expected: 'C2943749 BD', value: 'C2943749' }] }]);
    expect(toast).toHaveBeenCalledWith('1 fix saved.', 'SUCCESS');
    expect(changed).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.method === 'GET')).toHaveLength(2);
  });

  it('fixes a whole group after confirmation, and says what was skipped', async () => {
    fixReply = { status: 200, body: { applied: [{}], skipped: [{ serialNumber: 'BUT-002', field: 'sup_pn_2', reason: 'changed' }] } };
    await render();

    await click(button('Fix all 2', section('supplier_name'))!);

    expect(confirms[0]).toMatchObject({ title: 'Fix part numbers', confirmLabel: 'Apply 2 fixes' });
    expect(posts()[0].body.fixes.map((f: any) => [f.field, f.action, f.expected])).toEqual([
      ['sup_pn_1', 'move_to_supplier', 'MOUSER ELECTRONICS'], ['sup_pn_2', 'clear', 'DIGIKEY'],
    ]);
    expect(toast).toHaveBeenCalledWith('1 fix saved; 1 skipped because the value changed since the list was loaded.', 'INFO');
  });

  it("passes on the server's refusal", async () => {
    fixReply = { status: 403, body: { error: 'Only admins, managers and engineers can change inventory, prices and part numbers.' } };
    await render();

    await click(button('Clear')!);

    expect(toast).toHaveBeenCalledWith('Only admins, managers and engineers can change inventory, prices and part numbers.', 'ERROR');
    expect(changed).not.toHaveBeenCalled();
  });

  it('opens an item from the list', async () => {
    await render();

    await click(button('PCB-001')!);

    expect(openItem).toHaveBeenCalledWith('PCB-001');
  });

  it('shows a viewer the list without any fix buttons', async () => {
    localStorage.setItem('currentUser', JSON.stringify({ email: 'viewer@example.com', role: 'viewer' }));
    await render();

    expect(button('Use C2943749')).toBeUndefined();
    expect(buttons().some((b) => /^Fix all/.test(b.textContent?.trim() ?? ''))).toBe(false);
    expect(text(host)).toContain('Only admins, managers and engineers can change inventory, prices and part numbers. You can see the list.');
  });
});
