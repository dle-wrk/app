// @vitest-environment node
import type { Server } from 'node:http';
import express from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Which data-version counter a successful write bumps, so other people's
// open pages notice it (src/lib/liveUpdates.ts).

const bumped = vi.hoisted(() => [] as string[]);
vi.mock('./db', () => ({
  query: async (_text: string, params: any[] = []) => { bumped.push(params[0]); return { rows: [], rowCount: 1 }; },
  exec: async () => {},
}));

import { attachDataVersionMiddleware } from './dataVersion';

let server: Server;
let base = '';
beforeAll(async () => {
  const app = express();
  attachDataVersionMiddleware(app);
  app.all(/.*/, (req, res) => { res.status(req.path.endsWith('/refused') ? 409 : 200).json({}); });
  await new Promise<void>((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => new Promise<void>((resolve) => { server.close(() => resolve()); }));
beforeEach(() => { bumped.length = 0; });

const send = async (method: string, path: string) => {
  await fetch(`${base}${path}`, { method });
  await new Promise((r) => setTimeout(r, 20)); // the bump runs when the response has finished
  return [...bumped];
};

describe('attachDataVersionMiddleware', () => {
  it.each([
    ['POST', '/api/project-progress/60/stage', 'project_progress'],
    ['PUT', '/api/project-progress/stages', 'project_progress'],
    ['DELETE', '/api/projects/60', 'projects'],
    ['POST', '/api/items', 'inventory'],
    ['POST', '/api/kits', 'production_kits'],
  ])('%s %s bumps %s', async (method, path, key) => {
    expect(await send(method, path)).toEqual([key]);
  });

  it('bumps nothing for reads, refused writes, or paths nobody follows', async () => {
    expect(await send('GET', '/api/project-progress')).toEqual([]);
    expect(await send('POST', '/api/project-progress/60/refused')).toEqual([]);
    expect(await send('POST', '/api/somewhere-else')).toEqual([]);
  });
});
