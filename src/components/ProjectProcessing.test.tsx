import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectProcessingView, { previewCode } from './views/ProjectProcessingView';
import PageGuide from './PageGuide';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/confirmDialog', () => ({ confirmDialog: async () => true }));

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
let detail: any;
const BUILD = { id: 5, number: 'BLD-2026-0001', project_id: '60', project_name: 'NCU05', model_number: 'NCU05-POP', qty_planned: 2, qty_built: 0, qty_scrapped: 0, status: 'PLANNED', batch_code: 'NCU05-POP-B001', created_at: '2026-11-05T08:00:00Z' };
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  detail = { build: { ...BUILD }, product: { model_number: 'NCU05-POP', description: 'NCU05 populated', unit_format: '{MODEL}-{0000}', batch_format: '{MODEL}-B{000}' }, issues: [], returns: [], units: [], usage: [] };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/builds' && method === 'GET') return ok([BUILD]);
    if (url === '/api/builds/options') return ok({ projects: [{ id: '60', project_name: 'NCU05', status: 'Active' }], products: [{ model_number: 'NCU05-POP', description: 'NCU05 populated' }], boards: [] });
    if (url === '/api/builds' && method === 'POST') return ok({ ...BUILD, id: 6, number: 'BLD-2026-0002' });
    if (url.startsWith('/api/builds/') && url.endsWith('/book-in')) return ok({ code: 'NCU05-POP', serials: ['NCU05-POP-0001'] });
    if (url.match(/^\/api\/builds\/\d+$/)) return ok(detail);
    if (url === '/api/kit-booking/validate') return ok([
      { component_id: 'CAP-024', resolved_part_number: 'CAP-024', qty_required: 20, shortage_qty: 0 },
      { component_id: 'CON-010', resolved_part_number: 'CON-010', qty_required: 2, shortage_qty: 1 },
    ]);
    if (url === '/api/kit-booking/execute') return ok({ deductions: [{ code: 'CAP-024', qty: 20 }], skipped: ['CON-010'] });
    return ok({ ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const type = (aria: string, v: string) => act(() => {
  const el = host.querySelector(`input[aria-label="${aria}"]`) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const openBuild = async () => {
  await act(async () => { root.render(<ProjectProcessingView triggerToast={() => {}} />); });
  await act(async () => { button('BLD-2026-0001').click(); });
};

describe('Project Processing', () => {
  it('the ? next to the page name opens a how-to: on hover, and kept open by a click until Escape', async () => {
    await act(async () => { root.render(<PageGuide view="project_processing" />); });
    const help = host.querySelector('button[aria-label="How to use this page"]') as HTMLButtonElement;
    const wrap = help.parentElement!;
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => { wrap.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')!.textContent).toContain('Book the kit out');
    act(() => { wrap.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    act(() => { help.click(); });
    expect(help.getAttribute('aria-expanded')).toBe('true');
    act(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it('previews serials from a format', () => {
    expect(previewCode('{MODEL}-POP-{0000}', 'TCU06')).toBe('TCU06-POP-0001');
  });

  it('starts a build for a project and a Production Costs product', async () => {
    await act(async () => { root.render(<ProjectProcessingView triggerToast={() => {}} />); });
    await act(async () => { button('New build').click(); });
    await act(async () => {
      const sel = host.querySelector('select[aria-label="Project"]') as HTMLSelectElement;
      sel.value = '60'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // The project's last build made NCU05-POP, so it is filled in.
    expect((host.querySelector('input[aria-label="Product"]') as HTMLInputElement).value).toBe('NCU05-POP');
    type('Quantity', '5');
    await act(async () => { button('Start build').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/builds')!.body).toEqual({ projectId: '60', modelNumber: 'NCU05-POP', qty: '5', notes: '' });
  });

  it('book-out: a short line blocks it until it is left out, then books out against the build', async () => {
    await openBuild();
    await act(async () => { button('Check the kit').click(); });
    expect(host.textContent).toContain('1 line is short');
    expect((button('Book out for 2') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { (host.querySelector('input[aria-label="Leave out CON-010"]') as HTMLInputElement).click(); });
    await act(async () => { button('Book out for 2').click(); });
    expect(calls.find((c) => c.url === '/api/kit-booking/execute')!.body).toEqual({ projectId: '60', buildQty: 2, buildId: 5, dnf: ['CON-010'] });
  });

  it('a scanned unit label books it in; the count goes back, a packet where ticked', async () => {
    detail.build.status = 'BOOKED_OUT';
    detail.issues = [{ serial_number: 'CAP-024', booked_out: 20, name: '100NF', packaging: 'X1 REEL', packet_code: null }, { serial_number: 'RES-020', booked_out: 8, name: '10K', packaging: 'X1 REEL', packet_code: 'RES-020-PKT' }];
    await openBuild();
    const scan = host.querySelector('input[aria-label="Scan a unit"]') as HTMLInputElement;
    type('Scan a unit', 'NCU05-POP-0001');
    await act(async () => { scan.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    expect(calls.find((c) => c.url === '/api/builds/5/book-in')!.body).toEqual({ serials: ['NCU05-POP-0001'] });
    expect(host.textContent).toContain('Booked in NCU05-POP-0001 as NCU05-POP.');

    type('Counted back CAP-024', '3');
    type('Counted back RES-020', '25'); // more than sent: confirmed, still put back
    await act(async () => { (host.querySelector('input[aria-label="As a packet RES-020"]') as HTMLInputElement).click(); });
    expect((host.querySelector('input[aria-label="Packet code RES-020"]') as HTMLInputElement).value).toBe('RES-020-PKT');
    expect(host.querySelector('[data-return="RES-020"]')!.textContent).toContain('adds to it');
    await act(async () => { button('Put back 2 counted').click(); });
    expect(calls.find((c) => c.url === '/api/builds/5/returns')!.body).toEqual({ lines: [
      { serialNumber: 'CAP-024', counted: 3, toPacket: false },
      { serialNumber: 'RES-020', counted: 25, toPacket: true, packetCode: 'RES-020-PKT' },
    ] });
  });

  it('labelled units not booked in must be booked in or said to be scrapped before completing', async () => {
    detail.build.status = 'BUILDING'; detail.build.qty_built = 1;
    detail.issues = [{ serial_number: 'CAP-024', booked_out: 20 }];
    detail.returns = [{ serial_number: 'CAP-024', counted: 2, to_code: 'CAP-024' }];
    detail.usage = [{ serial_number: 'CAP-024', bookedOut: 20, returned: 2, used: 18, over: 0 }];
    detail.units = [{ serial: 'NCU05-POP-0001', status: 'IN_STOCK' }, { serial: 'NCU05-POP-0002', status: 'LABELLED' }];
    await openBuild();
    expect(host.querySelector('[data-testid="build-summary"]')!.textContent).toContain('1 of 2 built and booked in; 18 pieces of 1 parts used.');
    expect((button('Complete') as HTMLButtonElement).disabled).toBe(true);
    await act(async () => { [...host.querySelectorAll('label')].find((l) => l.textContent?.includes('were scrapped'))!.querySelector('input')!.click(); });
    await act(async () => { button('Complete').click(); });
    expect(calls.find((c) => c.url === '/api/builds/5/complete')!.body).toEqual({ scrapped: 0, notes: '', scrapUnbooked: true });
  });
});
