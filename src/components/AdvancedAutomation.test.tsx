import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AdvancedAutomationDashboard from './views/AdvancedAutomationDashboard';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('./RestockOrderFiles', () => ({ default: () => null }));

let host: HTMLDivElement; let root: Root; let calls: Array<{ method: string; url: string; body: any }>;
beforeEach(() => {
  calls = [];
  localStorage.setItem('currentUser', JSON.stringify({ role: 'admin' }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    const ok = (b: any) => ({ ok: true, json: async () => b }) as any;
    if (url === '/api/ml-models') return ok([{ id: 1, model_name: 'Demand Supplier Ranking v1', model_type: 'SUPPLIER_RANKING', model_version: '1', status: 'NEEDS_DATA', accuracy: null, model_metadata: { note: 'No supplier has 3 received orders yet.' } }]);
    if (url === '/api/analytics/forecasts') return ok([]);
    if (url.startsWith('/api/anomalies')) return ok([{ id: 5, entity_type: 'INVENTORY', entity_id: 'CHP-051', item_name: 'CHIP', severity: 'HIGH', status: 'DETECTED', description: '[BELOW_REORDER_LEVEL] CHP-051 at 1 units is below its reorder level of 50.' }]);
    if (url === '/api/supplier-intelligence') return ok([{ id: 1, supplier_id: '32', supplier_name: 'Minute Men press', performance_score: null, on_time_delivery_pct: null, quality_score: 100, notes: 'Not enough received orders to score (1 of 3).' }]);
    if (url === '/api/analytics/consumption-summary') return ok({ partsWithHistory: 4, partsForecastable: 0, totalConsumed: 10, parts: [] });
    if (url.startsWith('/api/analytics/reorder-recommendations')) return ok({ count: 0, demandBased: 0, recommendations: [] });
    if (url === '/api/analytics/anomaly-summary') return ok({ open: 1, bySeverity: { HIGH: 1 } });
    if (url === '/api/analytics/assess-suppliers') return ok({ assessed: 5, scored: 0 });
    return ok({ ok: true });
  }));
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text)!;
const render = async () => { await act(async () => { root.render(<AdvancedAutomationDashboard triggerToast={() => {}} />); }); };

describe('Advanced Automation', () => {
  it('anomalies: open ones, in words, and can be acknowledged or dismissed', async () => {
    await render();
    await act(async () => { button('Anomalies').click(); });
    expect(calls.some((c) => c.url === '/api/anomalies?status=open')).toBe(true);
    const row = host.querySelector('[data-anomaly="5"]')!;
    expect(row.textContent).toContain('below reorder level');
    expect(row.textContent).not.toContain('[BELOW_REORDER_LEVEL]');
    await act(async () => { button('Not a problem').click(); });
    expect(calls.find((c) => c.method === 'PUT' && c.url === '/api/anomalies/5')!.body).toEqual({ status: 'FALSE_POSITIVE' });
  });

  it('a new model has no typed-in accuracy; a model says what it does', async () => {
    await render();
    await act(async () => { button('ML Models').click(); });
    expect(host.textContent).toContain('No supplier has 3 received orders yet.');
    expect(host.textContent).toContain('No accuracy');
    await act(async () => { button('New Model').click(); });
    expect(host.textContent).not.toContain('Expected Accuracy');
    expect(host.textContent).toContain('Accuracy is only ever measured, by Train.');
  });

  it('suppliers without enough orders say so, rather than a score', async () => {
    await render();
    await act(async () => { button('Supplier Intel').click(); });
    expect(host.querySelector('[data-supplier="Minute Men press"]')!.textContent).toContain('Not enough orders');
    await act(async () => { button('Score suppliers').click(); });
    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/analytics/assess-suppliers')).toBe(true);
  });
});
