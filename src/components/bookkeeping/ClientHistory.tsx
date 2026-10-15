// Customer 360 > History: everything with this client, newest first:
// quotes, orders, invoices, payments, credit notes, deliveries, potential
// orders, moves between them, and notes people log (calls, meetings,
// emails) with an optional follow-up date. Server: GET /api/clients/:id/history.

import React, { useEffect, useState } from 'react';
import { MessageSquare, Phone, Users, Mail, FileText, Package, Receipt, Truck, DollarSign, Hourglass, Settings2, CalendarClock, Check, Loader2 } from 'lucide-react';
import { apiGet, apiPost, apiPut, fmtMoney, fmtDate, inputClass, selectClass, PrimaryButton } from './shared';
import { canChange } from '../../lib/changeAccess';
import type { HistoryEntry } from '../../lib/potentialOrders';

const ICON: Record<HistoryEntry['kind'], React.ReactNode> = {
  quotation: <FileText className="w-3.5 h-3.5" />, sales_order: <Package className="w-3.5 h-3.5" />, invoice: <Receipt className="w-3.5 h-3.5" />,
  payment: <DollarSign className="w-3.5 h-3.5" />, credit_note: <Receipt className="w-3.5 h-3.5" />, delivery: <Truck className="w-3.5 h-3.5" />,
  potential: <Hourglass className="w-3.5 h-3.5" />, note: <MessageSquare className="w-3.5 h-3.5" />, call: <Phone className="w-3.5 h-3.5" />,
  meeting: <Users className="w-3.5 h-3.5" />, email: <Mail className="w-3.5 h-3.5" />, system: <Settings2 className="w-3.5 h-3.5" />,
};
const FILTERS: Array<{ key: string; label: string; kinds: HistoryEntry['kind'][] | null }> = [
  { key: 'all', label: 'Everything', kinds: null },
  { key: 'notes', label: 'Notes & follow-ups', kinds: ['note', 'call', 'meeting', 'email'] },
  { key: 'docs', label: 'Documents', kinds: ['quotation', 'sales_order', 'invoice', 'payment', 'credit_note', 'delivery', 'potential'] },
  { key: 'moves', label: 'Changes', kinds: ['system'] },
];

export const ClientHistory: React.FC<{ clientId: number; onError: (msg: string) => void; onSaved?: (msg: string) => void }> = ({ clientId, onError, onSaved }) => {
  const [entries, setEntries] = useState<HistoryEntry[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [kind, setKind] = useState('call');
  const [body, setBody] = useState('');
  const [followUp, setFollowUp] = useState('');
  const [saving, setSaving] = useState(false);
  const mayNote = canChange(`/api/clients/${clientId}/events`, 'POST');

  const load = async () => {
    try { setEntries(await apiGet(`/api/clients/${clientId}/history`)); } catch (e: any) { onError(e?.message || 'Could not load the history.'); setEntries([]); }
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [clientId]);

  const add = async () => {
    if (!body.trim()) return;
    setSaving(true);
    try {
      await apiPost(`/api/clients/${clientId}/events`, { kind, body: body.trim(), followUpDate: followUp || null });
      setBody(''); setFollowUp('');
      onSaved?.(followUp ? `Saved, with a follow-up on ${fmtDate(followUp)}.` : 'Saved to the history.');
      await load();
    } catch (e: any) { onError(e?.message || 'Could not save it.'); } finally { setSaving(false); }
  };
  const done = async (id: number, value: boolean) => {
    try { await apiPut(`/api/client-events/${id}`, { followUpDone: value }); await load(); } catch (e: any) { onError(e?.message || 'Could not change it.'); }
  };

  const kinds = FILTERS.find((f) => f.key === filter)?.kinds;
  const shown = (entries ?? []).filter((e) => !kinds || kinds.includes(e.kind));
  const today = new Date().toISOString().slice(0, 10);

  return (
    <div className="space-y-3" data-testid="client-history">
      {mayNote && (
        <div className="rounded-lg border border-outline-variant bg-surface-container-high/40 p-3 space-y-2">
          <div className="flex flex-wrap gap-2">
            <select className={`${selectClass} py-1.5 text-xs w-32`} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind of note">
              <option value="call">Call</option><option value="meeting">Meeting</option><option value="email">Email</option><option value="note">Note</option>
            </select>
            <input className={`${inputClass} py-1.5 text-xs flex-1 min-w-[200px]`} value={body} onChange={(e) => setBody(e.target.value)} placeholder="e.g. Spoke to Sam: wants a revised price by Friday" aria-label="Note" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-on-surface-variant">
              <CalendarClock className="w-3.5 h-3.5" /> Follow up on
              <input type="date" className={`${inputClass} py-1 text-xs w-40`} value={followUp} onChange={(e) => setFollowUp(e.target.value)} aria-label="Follow-up date" />
              <span className="text-outline">(shows on the Dashboard that day)</span>
            </label>
            <PrimaryButton type="button" onClick={() => void add()} disabled={saving || !body.trim()}>{saving ? 'Saving…' : 'Add to history'}</PrimaryButton>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1" role="group" aria-label="Show">
        {FILTERS.map((f) => (
          <button key={f.key} type="button" onClick={() => setFilter(f.key)} aria-pressed={filter === f.key}
            className={`text-[10px] font-bold px-2 py-1 rounded border ${filter === f.key ? 'bg-primary text-on-primary border-primary' : 'bg-surface-container-high border-outline-variant text-on-surface-variant'}`}>{f.label}</button>
        ))}
      </div>

      {!entries ? <p className="text-xs text-outline flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" /> Loading…</p> : shown.length === 0 ? (
        <p className="text-xs text-on-surface-variant">Nothing yet.</p>
      ) : (
        <ol className="relative border-l border-outline-variant/50 ml-2 space-y-3">
          {shown.map((e, i) => {
            const due = e.followUpDate && !e.followUpDone && e.followUpDate <= today;
            return (
              <li key={`${e.kind}-${e.docNumber}-${e.eventId}-${i}`} className="ml-4">
                <span className={`absolute -left-[9px] flex items-center justify-center w-[18px] h-[18px] rounded-full border ${e.eventId ? 'bg-primary/15 border-primary/40 text-primary' : 'bg-surface-container-high border-outline-variant text-on-surface-variant'}`}>{ICON[e.kind]}</span>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-xs font-bold text-on-surface">{e.title}</span>
                  <span className="text-[10px] text-outline">{fmtDate(e.at)}{e.by ? ` · ${e.by}` : ''}</span>
                </div>
                {e.detail && <p className="text-[11px] text-on-surface-variant whitespace-pre-wrap">{e.detail}</p>}
                {e.amount != null && <p className="text-[11px] font-mono text-outline">{fmtMoney(e.amount, e.currency || 'ZAR')}</p>}
                {e.followUpDate && (
                  <div className={`mt-0.5 text-[10px] flex items-center gap-1.5 ${e.followUpDone ? 'text-outline line-through' : due ? 'text-amber-500 font-bold' : 'text-on-surface-variant'}`}>
                    <CalendarClock className="w-3 h-3" /> Follow up {fmtDate(e.followUpDate)}{due ? ' (due)' : ''}
                    {e.eventId != null && mayNote && (
                      <button type="button" onClick={() => void done(e.eventId!, !e.followUpDone)} className="no-underline inline-flex items-center gap-0.5 text-primary font-bold hover:underline" style={{ textDecoration: 'none' }}>
                        <Check className="w-3 h-3" /> {e.followUpDone ? 'Not done' : 'Done'}
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
