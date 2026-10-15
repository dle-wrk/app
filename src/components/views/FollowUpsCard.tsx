// Dashboard: client follow-ups due today or earlier (notes with a follow-up
// date, from Customer 360 > History) and Potential Orders whose decision
// date has come. Hidden when there is nothing due. Server: GET /api/follow-ups.

import React, { useEffect, useState } from 'react';
import { CalendarClock, Hourglass, Check } from 'lucide-react';
import { apiGet, apiPut, fmtMoney, fmtDate } from '../bookkeeping/shared';
import { canChange } from '../../lib/changeAccess';
import type { NavigateTarget } from './NeedsAttentionStrip';

interface FollowUps {
  notes: Array<{ id: number; clientId: number; clientName: string; kind: string; body: string; followUpDate: string; by: string | null }>;
  decisions: Array<{ id: number; number: string; clientName: string | null; expectedDate: string; total: number; currency: string; likelihoodPct: number | null; reason: string | null }>;
}

export const FollowUpsCard: React.FC<{ onNavigate?: (t: NavigateTarget) => void }> = ({ onNavigate }) => {
  const [data, setData] = useState<FollowUps | null>(null);
  const load = () => apiGet('/api/follow-ups').then(setData).catch(() => setData(null));
  useEffect(() => { void load(); }, []);
  if (!data || (!data.notes.length && !data.decisions.length)) return null;
  const mayTick = canChange('/api/client-events/1', 'PUT');
  const today = new Date().toISOString().slice(0, 10);
  const toPotential = () => onNavigate?.({ view: 'bookkeeping', section: 'SALES', subSection: 'POTENTIAL' });

  return (
    <div className="bg-surface-container border border-amber-500/30 rounded-xl p-md space-y-2" data-testid="follow-ups">
      <h4 className="text-sm font-bold text-on-surface flex items-center gap-2"><CalendarClock className="w-4 h-4 text-amber-500" /> Follow-ups due</h4>
      <ul className="divide-y divide-outline-variant/30 text-xs">
        {data.notes.map((n) => (
          <li key={`n${n.id}`} className="py-1.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-bold text-on-surface">{n.clientName}</span>
              <span className="text-outline"> · {n.kind} · {n.followUpDate < today ? `was due ${fmtDate(n.followUpDate)}` : 'today'}{n.by ? ` · ${n.by}` : ''}</span>
              <p className="text-on-surface-variant">{n.body}</p>
            </div>
            {mayTick && (
              <button type="button" onClick={async () => { try { await apiPut(`/api/client-events/${n.id}`, { followUpDone: true }); await load(); } catch { /* shown on next load */ } }}
                aria-label={`Mark the ${n.clientName} follow-up done`} className="shrink-0 inline-flex items-center gap-1 text-[11px] font-bold text-primary hover:underline">
                <Check className="w-3.5 h-3.5" /> Done
              </button>
            )}
          </li>
        ))}
        {data.decisions.map((d) => (
          <li key={`d${d.id}`} className="py-1.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <span className="font-bold text-on-surface flex items-center gap-1"><Hourglass className="w-3 h-3 text-primary" /> {d.number}{d.clientName ? ` · ${d.clientName}` : ''}</span>
              <span className="text-outline">Decision {d.expectedDate < today ? `was due ${fmtDate(d.expectedDate)}` : 'due today'} · {fmtMoney(d.total, d.currency)}{d.likelihoodPct != null ? ` · ${d.likelihoodPct}% likely` : ''}</span>
              {d.reason && <p className="text-on-surface-variant">{d.reason}</p>}
            </div>
            {onNavigate && <button type="button" onClick={toPotential} className="shrink-0 text-[11px] font-bold text-primary hover:underline">Open</button>}
          </li>
        ))}
      </ul>
    </div>
  );
};
