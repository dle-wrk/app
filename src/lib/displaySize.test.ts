import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./db', () => {
  const rows = new Map<number, any>();
  return {
    pool: { connect: async () => { throw new Error('no database in tests'); } },
    exec: async () => {},
    queryOne: async (_sql: string, [id]: [number]) => (rows.has(id) ? { prefs: rows.get(id) } : null),
    query: async (_sql: string, [id, json]: [number, string]) => {
      rows.set(id, { ...(rows.get(id) ?? {}), ...JSON.parse(json) });
      return { rows: [{ prefs: rows.get(id) }] };
    },
  };
});

import { applyDisplaySize, autoZoom, rememberedDisplaySize, zoomFor } from './displaySize';
import { registerUserPrefsRoutes } from './userPrefsRoutes';
import { permissionForWrite } from './writeAccess';

afterEach(() => { localStorage.clear(); document.documentElement.style.removeProperty('--app-zoom'); });

describe('display size', () => {
  it('Auto shrinks a scaled laptop screen to look like a 100% monitor, never enlarging', () => {
    expect(autoZoom(1280)).toBe(0.8);  // 1920 at 150% Windows scaling
    expect(autoZoom(1536)).toBe(0.95); // 1920 at 125%
    expect(autoZoom(1920)).toBe(1);
    expect(autoZoom(2560)).toBe(1);
    expect(autoZoom(1024)).toBe(0.8);  // never below 80%
    expect(zoomFor('large', 1280)).toBe(1.15);
  });

  it('applies the size to the page and remembers it in this browser', () => {
    expect(rememberedDisplaySize()).toBe('standard');
    expect(applyDisplaySize('compact')).toBe(0.85);
    expect(document.documentElement.style.getPropertyValue('--app-zoom')).toBe('0.85');
    expect(rememberedDisplaySize()).toBe('compact');
    localStorage.setItem('displaySize', 'huge');
    expect(rememberedDisplaySize()).toBe('standard');
  });
});

describe('preferences, saved to your own account', () => {
  const routes = new Map<string, Function>();
  registerUserPrefsRoutes({ get: (p: string, h: Function) => routes.set(`GET ${p}`, h), put: (p: string, h: Function) => routes.set(`PUT ${p}`, h) } as any);
  const call = async (key: string, user: any, body?: any) => {
    const res: any = { statusCode: 200, status(c: number) { this.statusCode = c; return this; }, json(b: any) { this.body = b; return this; } };
    await routes.get(key)!({ user, body }, res);
    return res;
  };

  it("keeps each person's own size, and refuses values it doesn't know", async () => {
    expect((await call('PUT /api/me/preferences', { id: 7 }, { displaySize: 'large' })).body).toEqual({ displaySize: 'large' });
    expect((await call('GET /api/me/preferences', { id: 7 })).body).toEqual({ displaySize: 'large' });
    expect((await call('GET /api/me/preferences', { id: 8 })).body).toEqual({}); // someone else
    expect((await call('PUT /api/me/preferences', { id: 7 }, { displaySize: 'huge' })).statusCode).toBe(400);
    expect((await call('PUT /api/me/preferences', { id: 7 }, { role: 'admin' })).statusCode).toBe(400);
    expect((await call('GET /api/me/preferences', undefined)).statusCode).toBe(401);
  });

  it('is open to every signed-in role, viewers included', () => {
    expect(permissionForWrite('PUT', '/api/me/preferences')).toBeNull();
  });
});
