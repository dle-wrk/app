import { describe, expect, it } from 'vitest';
import { permissionForWrite } from './writeAccess';
import { roleCan } from './permissions';

describe('who may build Sales Builder packages', () => {
  it('admins and managers change and delete them; engineers and viewers only use them', () => {
    expect(permissionForWrite('POST', '/api/sales-packages')).toBe('orders.update');
    expect(permissionForWrite('PUT', '/api/sales-packages/3')).toBe('orders.update');
    expect(permissionForWrite('DELETE', '/api/sales-packages/3')).toBe('orders.delete');
    expect(permissionForWrite('GET', '/api/sales-packages/3/expand')).toBeNull();
    for (const role of ['admin', 'manager']) expect(roleCan(role, 'orders.update'), role).toBe(true);
    for (const role of ['engineer', 'viewer']) expect(roleCan(role, 'orders.update'), role).toBe(false);
  });
});
