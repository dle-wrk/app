import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsView } from './ProjectsView';

// Drives the real Projects view's BOM Manager with a stubbed API.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NCU05 = { id: 60, projectName: 'NCU05', description: '', status: 'Active', createdDate: '2026-07-28' };
const item = (partNumber: string, project = '') =>
  ({ partNumber, name: `${partNumber} name`, description: `${partNumber} desc`, footprint: '', project, stockLevel: 10, price: 0, category: 'X', status: 'ACTIVE' }) as any;
// CAP-009 carries the "NCU05" project tag that old Syncs wrote, but it is
// not in the BOM.
const ITEMS = [item('ANT-001'), item('BUT-002', 'NCU05'), item('CAP-009', 'NCU05'), item('RES-005')];
const BOM = [
  { stockCode: 'BUT-002', quantity: 2, designator: 'S1, S2', comment: '', description: '', footprint: '', libref: '' },
  { stockCode: 'RES-005', quantity: 4, designator: 'R1-R4', comment: 'pull-ups', description: '', footprint: '', libref: '' },
];

type Call = { method: string; url: string; body?: any };
let calls: Call[];
let replies: Record<string, { status: number; body: unknown }>;
const toast = vi.fn();
let host: HTMLDivElement;
let root: Root;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

async function render(jobCards: any[] = []) {
  await act(async () => {
    root.render(<ProjectsView projects={[NCU05 as any]} items={ITEMS} projectReadiness={{}} jobCards={jobCards} triggerToast={toast}
      onProjectCreated={() => {}} onProjectDeleted={() => {}} onProjectUpdated={() => {}} />);
  });
  await settle();
}
const buttonNamed = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label)!;
const click = async (el: Element) => { await act(async () => { (el as HTMLElement).click(); }); await settle(); };
const openBomManager = () => click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Link Components'))!);
const bomCard = (stockCode: string) =>
  Array.from(document.querySelectorAll('div.bg-surface-container-high\\/50')).find((d) => d.querySelector('span.text-primary')?.textContent?.includes(stockCode)) as HTMLElement | undefined;
const bomCodes = () => Array.from(document.querySelectorAll('div.bg-surface-container-high\\/50 span.text-primary')).map((s) => s.textContent?.trim());
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const posts = (path: string) => calls.filter((c) => c.method === 'POST' && c.url === path);

beforeEach(() => {
  calls = [];
  replies = {};
  toast.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const scripted = replies[`${method} ${url}`];
    if (scripted) return reply(scripted.body, scripted.status);
    if (method === 'GET' && url === '/api/kits') return reply([]);
    if (method === 'GET' && url === '/api/projects/60/bom') return reply(BOM);
    if (method === 'POST') return reply({ ok: true });
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
});

describe('BOM Manager', () => {
  it('opens on exactly what the BOM holds, without parts that only carry the project tag', async () => {
    await render();
    await openBomManager();

    expect(bomCodes()).toEqual(['BUT-002', 'RES-005']);
    expect((bomCard('BUT-002')!.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('2');
    expect((bomCard('RES-005')!.querySelector('input[placeholder="e.g. C1, C2, R15"]') as HTMLInputElement).value).toBe('R1-R4');
  });

  it('saves the whole list, edits and removals included, and nothing else', async () => {
    await render([{ id: 1, projectId: 60, buildQty: 1, status: 'In Progress', createdAt: '' }]);
    await openBomManager();
    await type(bomCard('BUT-002')!.querySelector('input[type="number"]') as HTMLInputElement, '3');
    await click(bomCard('RES-005')!.querySelector('button')!); // remove RES-005

    await click(buttonNamed('Sync'));

    const saved = posts('/api/projects/60/bom');
    expect(saved).toHaveLength(1);
    expect(saved[0].body.replace).toBe(true);
    expect(saved[0].body.items.map((i: any) => [i.stockCode, i.quantity, i.designator])).toEqual([['BUT-002', 3, 'S1, S2']]);
    expect(posts('/api/projects/60/pp')[0].body).toMatchObject({ replace: true, items: [expect.objectContaining({ stockCode: 'BUT-002', quantity: 3 })] });
    // No more rewriting each part's inventory "project" field, and no
    // second job card for a project that already has one.
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);
    expect(posts('/api/job-cards')).toEqual([]);
    expect(toast).toHaveBeenCalledWith('1 components linked to project "NCU05"');
    expect(bomCodes()).toEqual([]); // modal closed
  });

  it('gives a project its first job card once', async () => {
    await render([]);
    await openBomManager();
    await click(buttonNamed('Sync'));
    await openBomManager();
    await click(buttonNamed('Sync'));

    expect(posts('/api/job-cards')).toHaveLength(1);
    expect(posts('/api/job-cards')[0].body).toEqual({ projectId: 60, buildQty: 0, status: 'Pending' });
  });

  it('says so when the BOM is not saved, and keeps the modal open', async () => {
    replies['POST /api/projects/60/bom'] = { status: 500, body: { error: 'there is no unique or exclusion constraint matching the ON CONFLICT specification' } };
    await render();
    await openBomManager();

    await click(buttonNamed('Sync'));

    expect(toast).toHaveBeenCalledWith('The BOM was not saved: there is no unique or exclusion constraint matching the ON CONFLICT specification', 'ERROR');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('linked to project'));
    expect(posts('/api/projects/60/pp')).toEqual([]);
    expect(posts('/api/job-cards')).toEqual([]);
    expect(bomCodes()).toEqual(['BUT-002', 'RES-005']);
  });

  it('warns when the BOM saved but Pick & Place did not', async () => {
    replies['POST /api/projects/60/pp'] = { status: 500, body: { error: 'boom' } };
    await render([{ id: 1, projectId: 60, buildQty: 1, status: 'Pending', createdAt: '' }]);
    await openBomManager();

    await click(buttonNamed('Sync'));

    expect(toast).toHaveBeenCalledWith('The BOM was saved, but Pick & Place was not updated: boom', 'ERROR');
    expect(toast).not.toHaveBeenCalledWith(expect.stringContaining('linked to project'));
  });

  it('does not open on an empty list when the BOM cannot be loaded', async () => {
    replies['GET /api/projects/60/bom'] = { status: 500, body: { error: 'database unavailable' } };
    await render();

    await openBomManager();

    expect(toast).toHaveBeenCalledWith('Could not load the BOM for NCU05: database unavailable', 'ERROR');
    expect(document.body.textContent).not.toContain('BOM Manager');
  });
});
