import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/activityLogger', () => ({
  fetchActivityLogs: async () => [
    { id: 2, created_at: '2026-10-15T08:20:00Z', user_email: null, action: 'CREATE_ITEMS', entity_type: 'items', entity_id: null, status: 'ERROR', ip_address: '1.2.3.4',
      details: { source: 'auto', actor: 'not signed in', error: 'Sign in required', sent: { serial_number: 'AUDIT-CHECK', password: '[hidden]' } } },
    { id: 1, created_at: '2026-10-15T08:16:43Z', user_email: 'dedw13@gmail.com', action: 'LOGIN', entity_type: null, entity_id: null, status: 'SUCCESS', ip_address: '1.2.3.4',
      details: '{"role":"admin"}' },
  ],
}));

import { ActivityLogsView } from './ActivityLogsView';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let csv = '';
beforeEach(() => {
  host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
  (URL as any).createObjectURL = vi.fn((b: Blob) => { b.text().then((t) => { csv = t; }); return 'blob:x'; });
  (URL as any).revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

describe('activity log CSV', () => {
  it('writes the details as readable JSON (not [object Object]), with the error and who it was', async () => {
    await act(async () => { root.render(<ActivityLogsView currentUserEmail="dedw13@gmail.com" />); });
    await settle();
    expect(host.textContent).toContain('not signed in');
    await act(async () => { ([...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'CSV') as HTMLButtonElement).click(); });
    await settle();
    expect(csv).not.toContain('[object Object]');
    const lines = csv.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Timestamp,User,Action,Entity Type,Entity ID,Status,Error,IP Address,Details');
    expect(lines[1]).toContain('not signed in,CREATE_ITEMS,items,,ERROR,Sign in required,1.2.3.4,');
    expect(lines[1]).toContain('""serial_number"":""AUDIT-CHECK""');
    expect(lines[2]).toContain('"{""role"":""admin""}"');
  });
});
