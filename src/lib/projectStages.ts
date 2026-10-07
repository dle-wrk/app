// Project stages: the steps a project goes through on the Project Progress
// board, and the small rules the server (./projectProgress) and the board
// (components/views/ProjectProgressView) share.
//
// The list itself lives in the project_stages table, where admins can
// rename, reorder, add and remove stages. DEFAULT_STAGES is what a database
// starts with. The last stage means finished: a project there is done, and
// is never overdue.

export const DEFAULT_STAGES = ['Planning', 'Design & BOM', 'Sourcing', 'Kitting', 'Assembly', 'Testing', 'Complete'];

export const MIN_STAGES = 2;
export const MAX_STAGES = 15;
export const STAGE_NAME_MAX = 40;
export const NOTE_MAX = 1000;

/** Days in one stage after which the board points the project out. */
export const STUCK_AFTER_DAYS = 30;

export interface Stage {
  id: number;
  name: string;
  position: number;
}

export interface StageEdit {
  /** null for a new stage. */
  id: number | null;
  name: string;
}

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/**
 * Checks an edited stage list (in its new order) against the stages that
 * exist. Names are trimmed, must be unique (ignoring case) and short; ids
 * must be existing stages, each used once.
 */
export function checkStageList(input: unknown, existingIds: number[]): { stages: StageEdit[] } | { error: string } {
  if (!Array.isArray(input)) return { error: 'Send the stages as a list.' };
  if (input.length < MIN_STAGES) return { error: `Keep at least ${MIN_STAGES} stages.` };
  if (input.length > MAX_STAGES) return { error: `Use at most ${MAX_STAGES} stages.` };
  const known = new Set(existingIds);
  const usedIds = new Set<number>();
  const usedNames = new Set<string>();
  const stages: StageEdit[] = [];
  for (const raw of input as any[]) {
    const name = typeof raw?.name === 'string' ? raw.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) return { error: 'Every stage needs a name.' };
    if (name.length > STAGE_NAME_MAX) return { error: `"${name.slice(0, 20)}…" is too long: keep stage names to ${STAGE_NAME_MAX} characters.` };
    if (CONTROL_CHARS.test(name)) return { error: `"${name}" has characters a stage name can't have.` };
    const key = name.toLowerCase();
    if (usedNames.has(key)) return { error: `"${name}" is in the list twice.` };
    usedNames.add(key);
    let id: number | null = null;
    if (raw?.id !== undefined && raw?.id !== null) {
      id = Number(raw.id);
      if (!Number.isInteger(id) || !known.has(id)) return { error: `Stage "${name}" no longer exists. Reload and try again.` };
      if (usedIds.has(id)) return { error: `Stage "${name}" is in the list twice.` };
      usedIds.add(id);
    }
    stages.push({ id, name });
  }
  return { stages };
}

/** A note or reason from a request: trimmed, at most NOTE_MAX characters, or null when empty. */
export function cleanNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, NOTE_MAX) : null;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as YYYY-MM-DD in local time. */
export function localDay(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * A project's due date as YYYY-MM-DD, or null. Project end dates are stored
 * as text: usually a YYYY-MM-DD from the date picker, sometimes something a
 * person typed. Anything that isn't a real date gives null.
 */
export function dueDay(text: string | null | undefined): string | null {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    const date = new Date(y, m - 1, d);
    return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
  }
  const t = Date.parse(value);
  return Number.isFinite(t) ? localDay(new Date(t)) : null;
}

/** Whole days from one YYYY-MM-DD day to another (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  const [a, b] = [from, to].map((d) => {
    const [y, m, day] = d.split('-').map(Number);
    return Date.UTC(y, m - 1, day);
  });
  return Math.round((b - a) / 86_400_000);
}

/** Whole days since a moment, or null when there is none. */
export function daysSince(iso: string | null | undefined, now: number = Date.now()): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** How a project's due date stands: days left (negative when overdue), or null without a usable date. */
export function dueStatus(endDate: string | null | undefined, finished: boolean, today: string = localDay()):
  { day: string; daysLeft: number; overdue: boolean } | null {
  const day = dueDay(endDate);
  if (!day) return null;
  const daysLeft = daysBetween(today, day);
  return { day, daysLeft, overdue: !finished && daysLeft < 0 };
}

/** The stage a project is shown in: its own, or the first one when none is set (or it has gone). */
export function effectiveStage(stages: Stage[], stageId: number | null | undefined): Stage | null {
  const ordered = [...stages].sort((a, b) => a.position - b.position || a.id - b.id);
  return ordered.find((s) => s.id === stageId) ?? ordered[0] ?? null;
}

/** Whether a stage is the last one (finished). */
export function isFinalStage(stages: Stage[], stageId: number | null | undefined): boolean {
  if (!stages.length) return false;
  const last = stages.reduce((a, b) => (b.position > a.position || (b.position === a.position && b.id > a.id) ? b : a));
  return effectiveStage(stages, stageId)?.id === last.id;
}

/** Project statuses (Project Manager's field) the board leaves out unless asked. */
export function isClosedStatus(status: string | null | undefined): boolean {
  const s = String(status ?? '').trim().toLowerCase();
  return s === 'inactive' || s === 'completed';
}
