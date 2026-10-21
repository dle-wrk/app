// Sync Stock > Footprint spellings: one package spelled more than one way
// ("DPAK", "DPAK-3 (TO-252-3)", "TO-252"). Parts only count as equivalent
// reels when footprints match exactly, so a person picks the spelling to keep
// and every item spelled another way gets it (src/lib/footprintRules).

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, SpellCheck } from 'lucide-react';
import { fmtNumber } from '../lib/formatMoney';
import { confirmDialog } from '../lib/confirmDialog';
import { currentUserCan } from '../lib/permissions';
import { SecondaryButton } from './bookkeeping/shared';

interface Group { package: string; spellings: Array<{ footprint: string; count: number; examples: string[] }> }

export default function FootprintSpellings({ onShowNotification, onChanged }: {
  onShowNotification: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
  onChanged?: () => void;
}) {
  const canFix = currentUserCan('inventory.update');
  const [groups, setGroups] = useState<Group[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/inventory/footprint-spellings');
      const body = await res.json().catch(() => ({}));
      if (res.ok) setGroups(body.groups ?? []);
    } catch { /* stays hidden; Sync Stock again to retry */ }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const use = async (g: Group, to: string) => {
    const from = g.spellings.filter((s) => s.footprint !== to);
    const n = from.reduce((t, s) => t + s.count, 0);
    if (!(await confirmDialog({
      title: `Spell ${g.package} one way`,
      message: `Change ${fmtNumber(n)} item${n === 1 ? '' : 's'} from ${from.map((s) => `"${s.footprint}"`).join(', ')} to "${to}"? It's recorded in the activity log.`,
      confirmLabel: `Use "${to}"`,
    }))) return;
    setBusy(g.package);
    try {
      const res = await fetch('/api/inventory/footprint-spellings/apply', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to, from: from.map((s) => s.footprint) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { onShowNotification(body.error || 'Could not change the footprints.', 'ERROR'); return; }
      const k = body.renamed?.length ?? 0;
      onShowNotification(`${fmtNumber(k)} item${k === 1 ? '' : 's'} now "${to}".`, 'SUCCESS');
      if (k) onChanged?.();
      await load();
    } finally { setBusy(null); }
  };

  if (!groups || groups.length === 0) return null;
  return (
    <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-sm" data-testid="footprint-spellings">
      <h4 className="text-base font-bold text-on-surface flex items-center gap-2"><SpellCheck className="w-4 h-4 text-primary" /> Footprint spellings</h4>
      <p className="text-xs text-on-surface-variant max-w-[720px]">
        {fmtNumber(groups.length)} package{groups.length === 1 ? ' is' : 's are'} spelled more than one way. Kit Booking and the Bill of Materials only offer a part as an equivalent reel when footprints match exactly,
        so choose the spelling to keep. A footprint that names a body width (such as SOIC-8-208MIL, wider than a standard SOIC-8) is never grouped.
      </p>
      <div className="divide-y divide-outline-variant/30 rounded-lg border border-outline-variant">
        {groups.map((g) => (
          <div key={g.package} className="p-sm flex flex-col md:flex-row gap-sm md:items-start" data-group={g.package}>
            <span className="md:w-28 shrink-0 font-mono font-bold text-on-surface text-xs pt-1">{g.package}</span>
            <div className="flex-1 flex flex-wrap gap-sm">
              {g.spellings.map((s) => (
                <div key={s.footprint} className="rounded border border-outline-variant bg-surface-container-high/40 px-2 py-1 text-[11px] flex items-center gap-2">
                  <span>
                    <span className="font-mono font-bold text-on-surface">{s.footprint}</span>
                    <span className="text-outline"> · {fmtNumber(s.count)} item{s.count === 1 ? '' : 's'} ({s.examples.join(', ')}{s.count > s.examples.length ? ', …' : ''})</span>
                  </span>
                  {canFix && (
                    <SecondaryButton type="button" disabled={busy !== null} onClick={() => void use(g, s.footprint)}
                      icon={busy === g.package ? <Loader2 className="w-3 h-3 animate-spin" /> : undefined}>Use this</SecondaryButton>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
