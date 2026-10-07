import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STAGES, MAX_STAGES, NOTE_MAX, checkStageList, cleanNote, daysBetween, daysSince, dueDay, dueStatus,
  effectiveStage, isClosedStatus, isFinalStage, localDay, type Stage,
} from './projectStages';

const STAGES: Stage[] = [
  { id: 4, name: 'Assembly', position: 2 },
  { id: 1, name: 'Planning', position: 0 },
  { id: 9, name: 'Complete', position: 3 },
  { id: 2, name: 'Sourcing', position: 1 },
];

describe('checkStageList', () => {
  it('trims names, keeps the order, and marks new stages with a null id', () => {
    expect(checkStageList([{ id: 1, name: '  Planning ' }, { name: 'Design   &  BOM' }, { id: 9, name: 'Done' }], [1, 2, 9])).toEqual({
      stages: [{ id: 1, name: 'Planning' }, { id: null, name: 'Design & BOM' }, { id: 9, name: 'Done' }],
    });
  });

  it.each([
    [undefined, 'Send the stages as a list.'],
    [[{ name: 'Only one' }], 'Keep at least 2 stages.'],
    [Array.from({ length: MAX_STAGES + 1 }, (_, i) => ({ name: `S${i}` })), `Use at most ${MAX_STAGES} stages.`],
    [[{ name: 'A' }, { name: '  ' }], 'Every stage needs a name.'],
    [[{ name: 'A' }, { name: 'x'.repeat(41) }], `"${'x'.repeat(20)}…" is too long: keep stage names to 40 characters.`],
    [[{ name: 'A' }, { name: 'B\u0007' }], '"B\u0007" has characters a stage name can\'t have.'],
    [[{ name: 'Testing' }, { name: 'testing' }], '"testing" is in the list twice.'],
    [[{ id: 1, name: 'A' }, { id: 77, name: 'B' }], 'Stage "B" no longer exists. Reload and try again.'],
    [[{ id: 1, name: 'A' }, { id: 1, name: 'B' }], 'Stage "B" is in the list twice.'],
    [[{ id: 'x', name: 'A' }, { name: 'B' }], 'Stage "A" no longer exists. Reload and try again.'],
  ])('refuses %j', (input, error) => {
    expect(checkStageList(input, [1, 2, 9])).toEqual({ error });
  });

  it('accepts the default stages', () => {
    expect('stages' in checkStageList(DEFAULT_STAGES.map((name) => ({ name })), [])).toBe(true);
  });
});

describe('cleanNote', () => {
  it('trims, caps the length, and gives null for nothing', () => {
    expect(cleanNote('  PCBs arrived  ')).toBe('PCBs arrived');
    expect(cleanNote('x'.repeat(NOTE_MAX + 50))).toHaveLength(NOTE_MAX);
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(42)).toBeNull();
    expect(cleanNote(undefined)).toBeNull();
  });
});

describe('dates', () => {
  it('reads due dates stored as text', () => {
    expect(dueDay('2026-10-14')).toBe('2026-10-14');
    expect(dueDay('2026-10-14T00:00:00Z')).toBe('2026-10-14');
    expect(dueDay('2026-02-30')).toBeNull();
    expect(dueDay('next week')).toBeNull();
    expect(dueDay('')).toBeNull();
    expect(dueDay(null)).toBeNull();
    expect(dueDay('Oct 14 2026')).toBe('2026-10-14');
  });

  it('counts days between days, across month ends and daylight saving changes', () => {
    expect(daysBetween('2026-10-07', '2026-10-14')).toBe(7);
    expect(daysBetween('2026-10-14', '2026-10-07')).toBe(-7);
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(daysBetween('2026-03-27', '2026-03-30')).toBe(3);
  });

  it('counts whole days since a moment', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    expect(daysSince('2026-10-07T08:00:00Z', now)).toBe(0);
    expect(daysSince('2026-10-06T11:00:00Z', now)).toBe(1);
    expect(daysSince('2026-09-07T12:00:00Z', now)).toBe(30);
    expect(daysSince('2026-10-08T12:00:00Z', now)).toBe(0); // a clock running ahead
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince('not a date', now)).toBeNull();
  });

  it('says how a due date stands, and never overdue once finished', () => {
    expect(dueStatus('2026-10-14', false, '2026-10-07')).toEqual({ day: '2026-10-14', daysLeft: 7, overdue: false });
    expect(dueStatus('2026-10-07', false, '2026-10-07')).toEqual({ day: '2026-10-07', daysLeft: 0, overdue: false });
    expect(dueStatus('2026-10-01', false, '2026-10-07')).toEqual({ day: '2026-10-01', daysLeft: -6, overdue: true });
    expect(dueStatus('2026-10-01', true, '2026-10-07')).toEqual({ day: '2026-10-01', daysLeft: -6, overdue: false });
    expect(dueStatus(null, false, '2026-10-07')).toBeNull();
  });

  it('gives a local YYYY-MM-DD', () => {
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('stages', () => {
  it('shows a project without a stage (or with one that went) in the first stage', () => {
    expect(effectiveStage(STAGES, 4)?.name).toBe('Assembly');
    expect(effectiveStage(STAGES, null)?.name).toBe('Planning');
    expect(effectiveStage(STAGES, 99)?.name).toBe('Planning');
    expect(effectiveStage([], 1)).toBeNull();
  });

  it('treats the last stage as finished', () => {
    expect(isFinalStage(STAGES, 9)).toBe(true);
    expect(isFinalStage(STAGES, 4)).toBe(false);
    expect(isFinalStage(STAGES, null)).toBe(false);
    expect(isFinalStage([], 9)).toBe(false);
  });

  it('knows the project statuses the board leaves out by default', () => {
    expect(['Active', 'ACTIVE', 'Inactive', 'Completed', ' completed ', null].map(isClosedStatus)).toEqual([false, false, true, true, true, false]);
  });
});
