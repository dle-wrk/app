import { describe, expect, it, vi } from 'vitest';
vi.mock('./db', () => ({ query: async () => ({ rows: [] }), queryOne: async () => null, exec: async () => {}, pool: {} }));
import { ncrStepError, defectStepError, defectRate } from './qualityRoutes';
import { scoreSupplier, MIN_RECEIVED } from './supplierScore';

describe('quality rules', () => {
  it('an NCR is assigned to someone, and resolved or closed with what was done', () => {
    expect(ncrStepError('ASSIGNED', {})).toBe('Say who it is assigned to.');
    expect(ncrStepError('IN_PROGRESS', { assigned_to: '  ' })).toBe('Say who it is assigned to.');
    expect(ncrStepError('ASSIGNED', { assigned_to: 'qa@tracklab' })).toBeNull();
    expect(ncrStepError('CLOSED', { assigned_to: 'qa' })).toMatch(/resolution/);
    expect(ncrStepError('RESOLVED', { resolution_notes: 'Reworked' })).toBeNull();
    expect(ncrStepError('OPEN', {})).toBeNull();
  });

  it('a defect is resolved or closed with how it was fixed', () => {
    expect(defectStepError('RESOLVED', { root_cause: 'bad reel' })).toMatch(/how it was fixed/);
    expect(defectStepError('CLOSED', { resolution_notes: 'Replaced' })).toBeNull();
    expect(defectStepError('INVESTIGATING', {})).toBeNull();
  });

  it('the defect rate is defects found per unit sampled, over completed inspections only', () => {
    expect(defectRate([])).toBeNull();
    expect(defectRate([{ status: 'SCHEDULED', sample_size: 50, defects_found: 0 }])).toBeNull();
    expect(defectRate([
      { status: 'PASSED', sample_size: 50, defects_found: 0 },
      { status: 'FAILED', sample_size: 30, defects_found: 4 },
      { status: 'SCHEDULED', sample_size: 100, defects_found: 0 },
    ])).toBe(5);
  });
});

describe('supplier score', () => {
  it('too few received orders: no score, and says why', () => {
    const s = scoreSupplier({ orders: 4, received: MIN_RECEIVED - 1, timed: 0, onTime: 0, ncrs: 0 });
    expect(s.score).toBeNull();
    expect(s.note).toMatch(/^Not enough received orders to score \(2 of 3\)/);
  });

  it('60% on time and 40% quality where on-time is known', () => {
    const s = scoreSupplier({ orders: 10, received: 10, timed: 8, onTime: 6, ncrs: 1, leadDays: 9 });
    expect(s.onTimePct).toBe(75);
    expect(s.qualityScore).toBe(90);
    expect(s.score).toBe(81); // 0.6 × 75 + 0.4 × 90
    expect(s.note).toContain('lead time 9 days');
  });

  it('quality only when no order has both dates', () => {
    const s = scoreSupplier({ orders: 5, received: 4, timed: 0, onTime: 0, ncrs: 1 });
    expect(s.onTimePct).toBeNull();
    expect(s.score).toBe(75);
    expect(s.note).toMatch(/^Quality only/);
  });

  it('more NCRs than orders bottoms out at 0, never negative', () => {
    expect(scoreSupplier({ orders: 3, received: 3, timed: 3, onTime: 0, ncrs: 9 }).score).toBe(0);
  });
});
