import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import QualityComplianceDashboard from './views/QualityComplianceDashboard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('../lib/confirmDialog', () => ({ confirmDialog: async () => true }));

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
const SUMMARY = {
  inspections: { passed: 3, failed: 1, hold: 0, open: 2, overdue: 1, done: 4, passRate: 75 }, defectRate: 2.5,
  defects: { open: 2, critical: 1, major: 1, minor: 0 }, ncrs: { open: 1, overdue: 1, resolved: 0, avg_days: null }, compliance: { checkpoints: 2, never: 1, failing: 0 },
};
const INSPECTION = { id: 7, component_id: 'ANT-001', item_name: 'FIBERGLASS', inspection_type: 'INCOMING', sample_size: 20, scheduled_day: '2026-10-27', inspector_id: 'qa@tracklab', status: 'SCHEDULED', defects_found: 0, notes: null };
const NCR = { id: 3, ncr_number: 'NCR-2026-0001', component_id: 'ANT-001', item_name: 'FIBERGLASS', issue_description: 'Pins out of spec', severity: 'MAJOR', status: 'OPEN', reported_by: 'qa', assigned_to: null, resolution_notes: null, overdue: false };
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/quality/summary') return ok(SUMMARY);
    if (url === '/api/qa-inspections' && method === 'GET') return ok([INSPECTION]);
    if (url === '/api/qa-inspections/7/result') return ok({ ...INSPECTION, status: 'FAILED', defects_found: 2, notes: 'bent pins' });
    if (url === '/api/ncr' && method === 'GET') return ok([NCR]);
    if (url === '/api/ncr' && method === 'POST') return ok({ ncr_number: 'NCR-2026-0002' });
    if (url.startsWith('/api/defects') && method === 'GET') return ok([]);
    if (url === '/api/compliance-checkpoints' && method === 'GET') return ok([{ id: 1, checkpoint_name: 'Incoming goods inspected', compliance_standard: 'ISO 9001', stage: 'Receiving', required_documentation: ['CoC'], is_active: true, last_status: null, checks: 0 }]);
    return ok({ ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const tab = (name: string) => [...host.querySelectorAll('[role="tab"]')].find((b) => b.textContent === name) as HTMLButtonElement;
const type = (aria: string, v: string) => act(() => {
  const el = host.querySelector(`input[aria-label="${aria}"]`) as HTMLInputElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, v);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
const render = async () => { await act(async () => { root.render(<QualityComplianceDashboard triggerToast={() => {}} items={[{ partNumber: 'ANT-001', name: 'FIBERGLASS' } as any]} suppliers={[{ id: 1, name: 'MOUSER' } as any]} />); }); };

describe('Quality & Compliance', () => {
  it('the overview is computed, with what needs attention', async () => {
    await render();
    expect(host.textContent).toContain('75%');
    expect(host.textContent).toContain('3 passed, 1 failed, 0 on hold; 2 to do');
    expect(host.textContent).not.toContain('2.3 days');
    const attention = host.querySelector('[data-testid="quality-attention"]')!.textContent!;
    expect(attention).toContain('1 inspection is past its date and not done');
    expect(attention).toContain('1 critical defect is open');
    expect(attention).toContain('1 compliance checkpoint has never been checked');
  });

  it('records a failed inspection and follows it up with an NCR, prefilled', async () => {
    await render();
    await act(async () => { tab('Inspections').click(); });
    await act(async () => { button('Record result').click(); });
    await act(async () => { button('Failed').click(); });
    type('Defects found', '2'); type('Inspection notes', 'bent pins');
    await act(async () => { button('Save result').click(); });
    expect(calls.find((c) => c.url === '/api/qa-inspections/7/result')!.body).toEqual({ result: 'FAILED', defects_found: 2, notes: 'bent pins' });
    expect(host.querySelector('[data-testid="inspection-failed"]')!.textContent).toContain('ANT-001 failed with 2 defects');
    await act(async () => { button('Raise an NCR').click(); });
    expect((host.querySelector('input[aria-label="Item not conforming"]') as HTMLInputElement).value).toBe('ANT-001');
    expect((host.querySelector('input[aria-label="Issue"]') as HTMLInputElement).value).toBe('bent pins');
    await act(async () => { button('Raise it').click(); });
    expect(calls.find((c) => c.method === 'POST' && c.url === '/api/ncr')!.body).toMatchObject({ component_id: 'ANT-001', qa_inspection_id: 7, severity: 'MAJOR' });
  });

  it('an NCR asks who it is assigned to before assigning, and the resolution before resolving', async () => {
    await render();
    await act(async () => { tab('NCRs').click(); });
    await act(async () => { button('Assign').click(); });
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    type('NCR assignee', 'qa@tracklab');
    await act(async () => { button('Save and assign').click(); });
    expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/ncr/3')!.body).toMatchObject({ status: 'ASSIGNED', assigned_to: 'qa@tracklab' });
  });

  it('compliance: record a check against a checkpoint', async () => {
    await render();
    await act(async () => { tab('Compliance').click(); });
    expect(host.querySelector('[data-checkpoint="Incoming goods inspected"]')!.textContent).toContain('Never checked.');
    await act(async () => { button('Record a check').click(); });
    type('Check reference', 'PO-2026-0003');
    await act(async () => { button('Record').click(); });
    expect(calls.find((c) => c.url === '/api/compliance-records')!.body).toEqual({ compliance_checkpoint_id: 1, status: 'COMPLIANT', reference: 'PO-2026-0003', notes: '' });
  });
});
