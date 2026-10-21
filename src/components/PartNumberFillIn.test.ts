import { describe, expect, it, vi } from 'vitest';
import { fixEverything } from './PartNumberFillIn';
import type { PartNumberIssue } from './PartNumberReview';

const issue = (serialNumber: string, kind: PartNumberIssue['kind'], fix: PartNumberIssue['fix'], field: string | null = 'sup_pn_1', value = 'X'): PartNumberIssue =>
  ({ kind, serialNumber, name: null, field, value, fix, note: '' });
const ok = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

describe('Sync Stock fixes every part number in rounds', () => {
  it('applies what is offered, then the slot moves that waited for it, and stops when nothing is left', async () => {
    const round1 = [issue('CAP-1', 'supplier_name', { action: 'move_to_supplier' }, 'sup_pn_1', 'Digikey'), issue('RES-2', 'placeholder', { action: 'clear' }, 'man_pn_2', 'TBD'), issue('IC-3', 'held_back', null)];
    const round2 = [issue('CAP-1', 'wrong_slot', { action: 'arrange_slots', value: '[]' }, null, '["C1"]'), issue('IC-3', 'held_back', null)];
    const round3 = [issue('IC-3', 'held_back', null)];
    const post = vi.fn()
      .mockReturnValueOnce(ok({ applied: [{ serialNumber: 'CAP-1' }, { serialNumber: 'RES-2' }], skipped: [] }))
      .mockReturnValueOnce(ok({ applied: [{ serialNumber: 'CAP-1' }], skipped: [] }));
    const reload = vi.fn().mockResolvedValueOnce(round2).mockResolvedValueOnce(round3);
    const r = await fixEverything(round1, post, reload);
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][0].fixes.map((f: any) => [f.serialNumber, f.action])).toEqual([['CAP-1', 'move_to_supplier'], ['RES-2', 'clear']]); // not the held-back one
    expect(post.mock.calls[1][0].fixes[0]).toMatchObject({ serialNumber: 'CAP-1', action: 'arrange_slots', expected: '["C1"]' });
    expect(r).toMatchObject({ applied: 3, items: 2, skipped: 0, left: round3 });
  });

  it('stops when a round changes nothing', async () => {
    const stuck = [issue('CAP-1', 'placeholder', { action: 'clear' })];
    const post = vi.fn(() => ok({ applied: [], skipped: [{ serialNumber: 'CAP-1' }] }));
    const r = await fixEverything(stuck, post, vi.fn().mockResolvedValue(stuck));
    expect(post).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({ applied: 0, skipped: 1 });
  });
});
