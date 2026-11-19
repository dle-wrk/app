import { describe, expect, it } from 'vitest';
import { mergeScans } from './ScanApp';
import type { Move } from './api';

const m = (id: number, at: string, status: Move['status'] = 'PENDING'): Move => ({
  id, status, direction: 'IN', partNumber: `P-${id}`, itemName: null, quantity: 1, stockAfter: null, location: null,
  reference: null, note: null, capturedAt: at, createdAt: at, decidedBy: null, rejectReason: null,
});

describe('My scans, scrolled', () => {
  it('adds an older page below, newest first', () => {
    const first = [m(5, '2026-11-19T10:00:00Z'), m(4, '2026-11-19T09:00:00Z')];
    const older = [m(3, '2026-11-18T09:00:00Z'), m(2, '2026-11-17T09:00:00Z')];
    expect(mergeScans(first, older).map(x => x.id)).toEqual([5, 4, 3, 2]);
  });

  it('a refresh brings new scans to the top and updates a status, without listing a scan twice', () => {
    const shown = [m(5, '2026-11-19T10:00:00Z'), m(4, '2026-11-19T09:00:00Z'), m(3, '2026-11-18T09:00:00Z')];
    const fresh = [m(6, '2026-11-19T11:00:00Z'), m(5, '2026-11-19T10:00:00Z', 'APPROVED')];
    const out = mergeScans(shown, fresh);
    expect(out.map(x => x.id)).toEqual([6, 5, 4, 3]);
    expect(out.find(x => x.id === 5)!.status).toBe('APPROVED');
  });

  it('a page that overlaps what is shown (new scans shifted it) adds only what is new', () => {
    const shown = [m(6, '2026-11-19T11:00:00Z'), m(5, '2026-11-19T10:00:00Z')];
    expect(mergeScans(shown, [m(5, '2026-11-19T10:00:00Z'), m(4, '2026-11-19T09:00:00Z')]).map(x => x.id)).toEqual([6, 5, 4]);
  });
});
