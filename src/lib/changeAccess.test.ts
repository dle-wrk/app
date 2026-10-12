import { describe, expect, it } from 'vitest';
import { canChange } from './changeAccess';

// The screens ask the server's own rule list whether to show a button.
describe('canChange', () => {
  it('follows the roles the server checks', () => {
    const who = (path: string, method: 'POST' | 'PUT' | 'DELETE' = 'POST') => ['admin', 'manager', 'engineer', 'viewer'].map((r) => canChange(path, method, r));
    expect(who('/api/items')).toEqual([true, true, true, false]);
    expect(who('/api/items/CAP-009', 'DELETE')).toEqual([true, true, false, false]);
    expect(who('/api/invoices')).toEqual([true, true, false, false]);
    expect(who('/api/kits/3/presence')).toEqual([true, true, true, true]);
    expect(canChange('/api/items', 'POST', null)).toBe(false);
  });
});
