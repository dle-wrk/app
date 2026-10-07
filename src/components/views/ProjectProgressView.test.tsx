import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ProjectProgressView, { type Board, type BoardProject, type LogEntry } from './ProjectProgressView';
import { announceDataChanged } from '../../lib/liveUpdates';

// The Project Progress board against a stubbed API.

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STAGES = ['Planning', 'Design & BOM', 'Sourcing', 'Kitting', 'Assembly', 'Testing', 'Complete'].map((name, i) => ({ id: i + 1, name, position: i }));

const proj = (over: Partial<BoardProject>): BoardProject => ({
  id: 1, name: 'TCU06 PCB', status: 'ACTIVE', team: null, startDate: null, endDate: null,
  stageId: 1, stageSet: false, stageSince: null, stageBy: null,
  onHold: false, holdReason: null, holdSince: null, holdBy: null, lastNote: null,
  kits: { count: 0, lastSavedAt: null }, builds: { inProgress: 0, inProgressQty: 0, completed: 0 }, lastActivityAt: null,
  ...over,
});

const TCU = proj({ id: 1, name: 'TCU06 PCB', endDate: '2026-10-01', kits: { count: 2, lastSavedAt: '2026-09-16T11:11:16Z' } });
const NCU = proj({
  id: 60, name: 'NCU05', status: 'Active', stageId: 5, stageSet: true, stageSince: '2026-09-20T09:00:00Z', stageBy: 'dylan@example.com',
  lastNote: { kind: 'stage', note: 'Kits picked', by: 'dylan@example.com', at: '2026-09-20T09:00:00Z' },
  builds: { inProgress: 2, inProgressQty: 3, completed: 0 }, lastActivityAt: '2026-10-06T04:01:56Z',
});
const PACK = proj({ id: 62, name: 'POWER PACK', status: 'Inactive', team: 'Line B' });

const HISTORY: LogEntry[] = [
  { id: 2, kind: 'update', fromStage: null, toStage: null, note: 'Stencil ordered', by: 'sam@example.com', at: '2026-10-01T09:00:00Z' },
  { id: 1, kind: 'stage', fromStage: 'Kitting', toStage: 'Assembly', note: 'Kits picked', by: 'dylan@example.com', at: '2026-09-20T09:00:00Z' },
];

let calls: Array<{ method: string; url: string; body?: any }>;
let boardData: Board;
let replies: Record<string, { status: number; body: unknown }>;
const toast = vi.fn();
const openManager = vi.fn();
let host: HTMLDivElement;
let root: Root;

const reply = (data: unknown, status = 200) => ({ ok: status < 400, status, json: async () => data }) as unknown as Response;
const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-07T10:00:00Z'));
  localStorage.clear();
  calls = [];
  boardData = { stages: STAGES, projects: [TCU, NCU, PACK], can: { move: true, editStages: false } };
  replies = {};
  toast.mockClear();
  openManager.mockClear();
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method || 'GET').toUpperCase();
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const scripted = replies[`${method} ${url}`];
    if (scripted) return reply(scripted.body, scripted.status);
    if (method === 'GET' && url === '/api/project-progress') return reply(boardData);
    if (method === 'GET' && /^\/api\/project-progress\/\d+\/history$/.test(url)) return reply({ entries: HISTORY });
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
  vi.useRealTimers();
});

const READINESS = { 60: [{ shortage_qty: 0 }, { shortage_qty: 2 }], 1: [] };
const render = async (props: Partial<React.ComponentProps<typeof ProjectProgressView>> = {}) => {
  await act(async () => {
    root.render(<ProjectProgressView projectReadiness={READINESS} triggerToast={toast} onOpenProjectManager={openManager} {...props} />);
  });
  await settle();
};
const q = <T extends Element = HTMLElement>(sel: string) => host.ownerDocument.querySelector<T>(sel);
const qa = (sel: string) => [...host.ownerDocument.querySelectorAll<HTMLElement>(sel)];
const button = (label: string | RegExp) => qa('button').find((b) => (typeof label === 'string'
  ? (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === label
  : label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))) as HTMLButtonElement | undefined;
const click = async (el: Element | undefined | null) => {
  expect(el).toBeTruthy();
  await act(async () => { (el as HTMLElement).click(); });
  await settle();
};
const type = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
  expect(el).toBeTruthy();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el!.dispatchEvent(new Event('input', { bubbles: true }));
  });
};
const submit = async (form: HTMLFormElement | null | undefined) => {
  expect(form).toBeTruthy();
  await act(async () => { form!.requestSubmit(); });
  await settle();
};
const gets = (url: string) => calls.filter((c) => c.method === 'GET' && c.url === url).length;
const posts = (url: string) => calls.filter((c) => c.method === 'POST' && c.url === url).map((c) => c.body);

describe('ProjectProgressView', () => {
  it('shows every project in the column of the stage it is at, with what the app knows about it', async () => {
    await render();
    const assembly = q('[data-testid="stage-column-5"]')!;
    const ncu = assembly.querySelector('[data-testid="project-card-60"]')!;
    expect(ncu.textContent).toContain('NCU05');
    expect(ncu.textContent).toContain('17 days in Assembly');
    expect(ncu.textContent).toContain('BOM 2 · 1 short');
    expect(ncu.textContent).toContain('Building 3');
    expect(ncu.textContent).toContain('“Kits picked” — dylan, 17 days ago');
    expect(assembly.querySelector('header')!.textContent).toContain('1');

    // Never moved: shown in the first stage, and said so.
    const tcu = q('[data-testid="stage-column-1"] [data-testid="project-card-1"]')!;
    expect(tcu.textContent).toContain('Stage not set yet');
    expect(tcu.textContent).toMatch(/Due .*2026 · 6 days overdue/);
    expect(tcu.textContent).toContain('No BOM');
    expect(tcu.textContent).toContain('2 kits');
    expect(host.textContent).toContain("1 project hasn't been given a stage yet, so it shows in Planning.");

    // Inactive projects only when asked for.
    expect(q('[data-testid="project-card-62"]')).toBeNull();
    const showClosed = qa('label').find((l) => l.textContent?.includes('Show inactive and completed projects (1)'))!.querySelector('input')!;
    await click(showClosed);
    expect(q('[data-testid="stage-column-1"] [data-testid="project-card-62"]')).not.toBeNull();
  });

  it('counts the projects and filters on a count', async () => {
    await render();
    expect(button('2 in progress')).toBeTruthy();
    expect(button('0 on hold')).toBeTruthy();
    expect(button('0 finished')).toBeTruthy();
    await click(button('1 overdue'));
    expect(q('[data-testid="project-card-1"]')).not.toBeNull();
    expect(q('[data-testid="project-card-60"]')).toBeNull();
    await click(button('1 overdue'));
    expect(q('[data-testid="project-card-60"]')).not.toBeNull();
  });

  it('searches by name, stage, team or note', async () => {
    await render();
    await type(q<HTMLInputElement>('input[aria-label="Search projects"]'), 'kits picked');
    expect(q('[data-testid="project-card-60"]')).not.toBeNull();
    expect(q('[data-testid="project-card-1"]')).toBeNull();
  });

  it('moves a project on to its next stage with a note, then reloads', async () => {
    await render();
    await click(button('Move NCU05 on to Testing'));
    expect(host.ownerDocument.body.textContent).toContain('From Assembly to Testing');
    replies['POST /api/project-progress/60/stage'] = { status: 200, body: { projectId: 60, stageId: 6, stageName: 'Testing', entry: {} } };
    await type(q<HTMLTextAreaElement>('#move-note'), 'Boards assembled');
    const before = gets('/api/project-progress');
    await submit(q<HTMLTextAreaElement>('#move-note')!.form);
    expect(posts('/api/project-progress/60/stage')).toEqual([{ stageId: 6, note: 'Boards assembled' }]);
    expect(toast).toHaveBeenCalledWith('NCU05 moved to Testing.', 'SUCCESS');
    expect(gets('/api/project-progress')).toBe(before + 1);
    expect(q('#move-note')).toBeNull();
  });

  it("shows the server's reason when a move is refused, and reloads the board", async () => {
    await render();
    await click(button('Move NCU05 back to Kitting'));
    replies['POST /api/project-progress/60/stage'] = { status: 409, body: { error: 'NCU05 is already in Kitting.' } };
    const before = gets('/api/project-progress');
    await submit(q<HTMLTextAreaElement>('#move-note')!.form);
    expect(toast).toHaveBeenCalledWith('NCU05 is already in Kitting.', 'ERROR');
    expect(gets('/api/project-progress')).toBe(before + 1);
  });

  it('opens the move dialog when a card is dragged onto another stage', async () => {
    await render();
    const drag = (el: Element, kind: string) => {
      const e = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), getData: () => '60', effectAllowed: '', dropEffect: '' } });
      el.dispatchEvent(e);
    };
    await act(async () => { drag(q('[data-testid="project-card-60"]')!, 'dragstart'); });
    const testing = q('[data-testid="stage-column-6"]')!;
    await act(async () => { drag(testing, 'dragover'); drag(testing, 'drop'); });
    await settle();
    expect(host.ownerDocument.body.textContent).toContain('From Assembly to Testing');
  });

  it('does nothing when a card is dropped back on its own stage', async () => {
    await render();
    const drag = (el: Element, kind: string) => {
      const e = new Event(kind, { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'dataTransfer', { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } });
      el.dispatchEvent(e);
    };
    await act(async () => { drag(q('[data-testid="project-card-60"]')!, 'dragstart'); });
    const assembly = q('[data-testid="stage-column-5"]')!;
    await act(async () => { drag(assembly, 'dragover'); drag(assembly, 'drop'); });
    await settle();
    expect(q('#move-note')).toBeNull();
  });

  it('lets viewers look but not move', async () => {
    boardData = { ...boardData, can: { move: false, editStages: false } };
    await render();
    expect(host.textContent).toContain('Only admins, managers and engineers can move projects between stages, put them on hold or add updates. You can see the board.');
    expect(button(/Move NCU05/)).toBeUndefined();
    expect(q('[data-testid="project-card-60"]')!.getAttribute('draggable')).toBe('false');
    expect(button('Edit stages')).toBeUndefined();
    await click(button('NCU05'));
    expect(host.ownerDocument.body.textContent).toContain('Stencil ordered');
    expect(button('Put on hold')).toBeUndefined();
    expect(q('#progress-update')).toBeNull();
  });

  it("shows a project's details and history, and puts it on hold, resumes it and adds updates", async () => {
    await render();
    await click(button('NCU05'));
    const body = host.ownerDocument.body;
    expect(gets('/api/project-progress/60/history')).toBe(1);
    expect(body.textContent).toContain('Moved from Kitting to Assembly');
    expect(body.textContent).toContain('Stencil ordered');
    expect(q('[aria-current="step"]')!.textContent).toContain('Assembly');

    await click(button('Put on hold'));
    replies['POST /api/project-progress/60/hold'] = { status: 200, body: { projectId: 60, onHold: true, entry: {} } };
    await type(q<HTMLInputElement>('#hold-reason'), 'Waiting for PCBs');
    await submit(q<HTMLInputElement>('#hold-reason')!.form);
    expect(posts('/api/project-progress/60/hold')).toEqual([{ onHold: true, reason: 'Waiting for PCBs' }]);
    expect(toast).toHaveBeenCalledWith('NCU05 is on hold.', 'SUCCESS');

    // The board comes back with the project on hold.
    boardData = { ...boardData, projects: [TCU, { ...NCU, onHold: true, holdReason: 'Waiting for PCBs', holdSince: '2026-10-07T09:59:00Z', holdBy: 'sam@example.com' }, PACK] };
    await act(async () => { announceDataChanged(['project_progress']); });
    await settle();
    expect(body.textContent).toContain('On hold since');
    expect(q('[data-testid="project-card-60"]')!.textContent).toContain('On hold: Waiting for PCBs');
    replies['POST /api/project-progress/60/hold'] = { status: 200, body: { projectId: 60, onHold: false, entry: {} } };
    await click(button('Resume'));
    expect(posts('/api/project-progress/60/hold')[1]).toEqual({ onHold: false });
    expect(toast).toHaveBeenCalledWith('NCU05 resumed.', 'SUCCESS');

    replies['POST /api/project-progress/60/update'] = { status: 200, body: { projectId: 60, entry: {} } };
    await type(q<HTMLTextAreaElement>('#progress-update'), 'Stencil arrived');
    await submit(q<HTMLTextAreaElement>('#progress-update')!.form);
    expect(posts('/api/project-progress/60/update')).toEqual([{ note: 'Stencil arrived' }]);
    expect(q<HTMLTextAreaElement>('#progress-update')!.value).toBe('');
  });

  it('moves a project from its details by clicking a stage, and sets a stage that was never set', async () => {
    await render();
    await click(button('TCU06 PCB'));
    // Not set yet: its current (first) stage can be picked too.
    const planning = qa('ol button').find((b) => b.textContent?.includes('Planning'))!;
    expect((planning as HTMLButtonElement).disabled).toBe(false);
    await click(qa('ol button').find((b) => b.textContent?.includes('Sourcing')));
    replies['POST /api/project-progress/1/stage'] = { status: 200, body: { projectId: 1, stageId: 3, stageName: 'Sourcing', entry: {} } };
    await submit(q<HTMLTextAreaElement>('#details-move-note')!.form);
    expect(posts('/api/project-progress/1/stage')).toEqual([{ stageId: 3, note: '' }]);
    expect(toast).toHaveBeenCalledWith('TCU06 PCB moved to Sourcing.', 'SUCCESS');
  });

  it('opens Project Manager from the details', async () => {
    await render();
    await click(button('NCU05'));
    await click(button('Open Project Manager'));
    expect(openManager).toHaveBeenCalled();
  });

  it('lists the projects, and moves one from the list', async () => {
    await render();
    await click(button('List'));
    expect(localStorage.getItem('projectProgress.layout')).toBe('list');
    expect(qa('tbody tr').map((r) => r.getAttribute('data-testid'))).toEqual(['project-row-1', 'project-row-60']);
    expect(q('[data-testid="project-row-60"]')!.textContent).toContain('5 of 7');
    const select = q<HTMLSelectElement>('select[aria-label="Move NCU05 to"]')!;
    expect([...select.options].map((o) => o.textContent)).not.toContain('Assembly');
    await act(async () => {
      select.value = '7';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await settle();
    expect(host.ownerDocument.body.textContent).toContain('Complete is the last stage: the project will show as finished.');
  });

  it('remembers the list layout', async () => {
    localStorage.setItem('projectProgress.layout', 'list');
    await render();
    expect(q('table')).not.toBeNull();
  });

  it('lets admins rename, reorder and add stages, but not remove one with projects in it', async () => {
    boardData = { ...boardData, can: { move: true, editStages: true } };
    await render();
    await click(button('Edit stages'));
    expect(button('Remove Assembly')!.disabled).toBe(true);
    expect(button('Remove Kitting')!.disabled).toBe(false);
    await click(button('Remove Kitting'));
    await type(q<HTMLInputElement>('input[aria-label="Stage 1 name"]'), 'Scoping');
    await click(button('Move Sourcing up'));
    await click(button('Add a stage'));
    const inputs = qa('input[aria-label^="Stage "]') as HTMLInputElement[];
    await type(inputs[inputs.length - 2], 'Packing');
    replies['PUT /api/project-progress/stages'] = { status: 200, body: { stages: [] } };
    await submit(q<HTMLInputElement>('input[aria-label="Stage 1 name"]')!.form);
    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body.stages).toEqual([
      { id: 1, name: 'Scoping' }, { id: 3, name: 'Sourcing' }, { id: 2, name: 'Design & BOM' },
      { id: 5, name: 'Assembly' }, { id: 6, name: 'Testing' }, { id: null, name: 'Packing' }, { id: 7, name: 'Complete' },
    ]);
    expect(toast).toHaveBeenCalledWith('Stages saved.', 'SUCCESS');
  });

  it("shows the server's reason when the stages can't be saved", async () => {
    boardData = { ...boardData, can: { move: true, editStages: true } };
    await render();
    await click(button('Edit stages'));
    replies['PUT /api/project-progress/stages'] = { status: 409, body: { error: 'Move the projects out of Kitting (1 project) before removing it.' } };
    await submit(q<HTMLInputElement>('input[aria-label="Stage 1 name"]')!.form);
    expect(q('[role="alert"]')!.textContent).toBe('Move the projects out of Kitting (1 project) before removing it.');
  });

  it('reloads when someone else changes progress, a project or a kit, and not for other changes', async () => {
    await render();
    const before = gets('/api/project-progress');
    await act(async () => { announceDataChanged(['inventory']); });
    await settle();
    expect(gets('/api/project-progress')).toBe(before);
    for (const key of ['project_progress', 'projects', 'production_kits']) {
      await act(async () => { announceDataChanged([key]); });
      await settle();
    }
    expect(gets('/api/project-progress')).toBe(before + 3);
  });

  it('says when the board could not be loaded, and tries again', async () => {
    replies['GET /api/project-progress'] = { status: 500, body: { error: 'database asleep' } };
    await render();
    expect(host.textContent).toContain('database asleep');
    delete replies['GET /api/project-progress'];
    await click(button('Try again'));
    expect(q('[data-testid="project-card-60"]')).not.toBeNull();
  });

  it('points to Project Manager when there are no projects', async () => {
    boardData = { ...boardData, projects: [] };
    await render();
    await click(button('Create one in Project Manager.'));
    expect(openManager).toHaveBeenCalled();
  });
});
