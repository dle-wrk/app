// Stock > Locations & Counts: the places stock is kept, what each holds, and
// stock counts (server: src/lib/stockPlaces.ts, src/lib/stockCounts.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, MapPin, ClipboardList, Plus, Pencil, Trash2, CheckCircle2, Search } from 'lucide-react';
import { canChange } from '../../lib/changeAccess';
import { confirmDialog } from '../../lib/confirmDialog';
import { fmtNumber } from '../../lib/formatMoney';
import { PrimaryButton, SecondaryButton } from '../bookkeeping/shared';
import LotTrace from '../LotTrace';
import type { Item } from '../../types';

type Toast = (msg: string, type?: string) => void;
interface Location { id: number; code: string; name: string | null; notes: string | null; active: boolean; items: number; units: number;
  /** The stock item this location is named after, if any (ANT-001). */
  item_serial: string | null; item_name: string | null; item_stock: number | null; item_unplaced: number | null }
interface Count { id: number; number: string; scope: string; location_code: string | null; prefix: string | null; status: string; created_by: string | null; created_at: string; posted_at: string | null; lines: number; counted: number; summary?: any }
interface CountLine { id: number; serial_number: string; name: string | null; location_code: string | null; lot: string | null; expected: number; now: number; counted: number | null; note: string | null; added: boolean; bin_id: number | null }

const input = 'bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface';
const when = (d: string | null) => (d ? new Date(d).toLocaleString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

async function api<T = any>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init && init.body ? { ...init, headers: { 'Content-Type': 'application/json' } } : init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || res.statusText);
  return body;
}

/** Count an item's stock in the location named after it, and put it away there (POST /api/stock-locations/:id/put-here). */
function PutHere({ l, triggerToast, onDone, onCancel }: { l: Location; triggerToast: Toast; onDone: () => void; onCancel: () => void }) {
  const have = l.item_unplaced ?? 0;
  const [counted, setCounted] = useState(String(have));
  const [rest, setRest] = useState<'elsewhere' | 'missing'>('elsewhere');
  const [busy, setBusy] = useState(false);
  const c = counted === '' ? null : Number(counted);
  const fewer = c !== null && c < have; const more = c !== null && c > have;
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api(`/api/stock-locations/${l.id}/put-here`, { method: 'POST', body: JSON.stringify({ serialNumber: l.item_serial, counted: c, rest }) });
      triggerToast(`${fmtNumber(r.move)} of ${l.item_serial} put away in ${l.code}${r.stockChange ? `; stock ${r.stockChange > 0 ? '+' : ''}${fmtNumber(r.stockChange)} (recorded as a count)` : ''}.`, 'SUCCESS');
      onDone();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-lg border border-primary/40 bg-primary/5 p-sm space-y-sm text-xs" data-testid={`put-here-${l.code}`}>
      <p className="text-on-surface"><strong>{l.item_serial}</strong> {l.item_name ? `(${l.item_name}) ` : ''}has {fmtNumber(l.item_stock ?? 0)} in stock, {fmtNumber(have)} not put away yet. How many are in {l.code}?</p>
      <div className="flex flex-wrap items-center gap-sm">
        <input className={`${input} w-28 py-1.5 font-mono text-right`} inputMode="numeric" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^0-9]/g, ''))} aria-label={`Counted in ${l.code}`} />
        {c === have && <span className="text-green-500">Matches the system.</span>}
        {more && <span className="text-amber-500">{fmtNumber(c! - have)} more than the system: they are added to stock as a count.</span>}
        {fewer && (
          <span className="flex flex-wrap items-center gap-sm">
            <span className="text-amber-500">The other {fmtNumber(have - c!)}:</span>
            <label className="flex items-center gap-1"><input type="radio" checked={rest === 'elsewhere'} onChange={() => setRest('elsewhere')} /> are somewhere else (leave them as not put away)</label>
            <label className="flex items-center gap-1"><input type="radio" checked={rest === 'missing'} onChange={() => setRest('missing')} /> aren't there (take them off stock)</label>
          </span>
        )}
      </div>
      <div className="flex gap-sm justify-end">
        <SecondaryButton type="button" onClick={onCancel}>Not now</SecondaryButton>
        <PrimaryButton type="button" disabled={busy || c === null || (c === 0 && !fewer)} onClick={() => void confirm()}>{busy ? 'Putting away…' : 'Confirm'}</PrimaryButton>
      </div>
    </div>
  );
}

/** One bin per item: a location named after each item's stock code, holding the stock not put away yet. */
function OneBinPerItem({ triggerToast, onDone, onCancel }: { triggerToast: Toast; onDone: () => void; onCancel: () => void }) {
  const [prefix, setPrefix] = useState('');
  const [rows, setRows] = useState<Array<{ serial_number: string; name: string | null; stock: number; unplaced: number; location_id: number | null }> | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => { api(`/api/stock-locations/one-per-item?prefix=${encodeURIComponent(prefix)}`).then((r) => setRows(r.items)).catch((e) => triggerToast(e.message, 'ERROR')); }, 250);
    return () => clearTimeout(t);
  }, [prefix, triggerToast]);
  const chosen = (rows ?? []).filter((r) => !off.has(r.serial_number));
  const go = async () => {
    setBusy(true);
    try {
      const r = await api('/api/stock-locations/one-per-item', { method: 'POST', body: JSON.stringify({ serials: chosen.map((x) => x.serial_number) }) });
      triggerToast(`${fmtNumber(r.done.length)} item${r.done.length === 1 ? '' : 's'} put away, each in a bin named after it.`, 'SUCCESS');
      onDone();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-primary/40 bg-primary/5 p-md space-y-sm text-xs" data-testid="one-bin-per-item">
      <p className="text-on-surface">Each item below gets a bin named after its stock code (ANT-001 goes in bin ANT-001), and its stock that isn't put away yet goes in it. The system's amount is used; if a bin turns out different, put it right later with <strong>Check stock</strong>.</p>
      <div className="flex flex-wrap items-center gap-sm">
        <input className={`${input} w-56 py-1.5 text-xs font-mono`} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Only codes starting with… (e.g. CAP-)" aria-label="Only codes starting with" />
        {rows && <span className="text-outline">{fmtNumber(chosen.length)} of {fmtNumber(rows.length)} ticked</span>}
        {rows && rows.length > 0 && <button type="button" className="text-primary underline" onClick={() => setOff(off.size ? new Set() : new Set(rows.map((r) => r.serial_number)))}>{off.size ? 'Tick all' : 'Untick all'}</button>}
      </div>
      {!rows ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : rows.length === 0 ? <p className="text-outline">Nothing to put away{prefix ? ` starting with ${prefix}` : ''}.</p> : (
        <div className="max-h-[300px] overflow-y-auto custom-scrollbar rounded-lg border border-outline-variant bg-surface-container">
          <table className="w-full text-[11px]"><tbody className="divide-y divide-outline-variant/30">{rows.map((r) => (
            <tr key={r.serial_number}>
              <td className="px-sm py-1"><input type="checkbox" checked={!off.has(r.serial_number)} onChange={() => setOff((o) => { const n = new Set(o); n.has(r.serial_number) ? n.delete(r.serial_number) : n.add(r.serial_number); return n; })} aria-label={`Put away ${r.serial_number}`} /></td>
              <td className="px-sm py-1 font-mono font-bold">{r.serial_number}</td><td className="px-sm py-1 text-on-surface-variant">{r.name}</td>
              <td className="px-sm py-1 text-right font-mono">{fmtNumber(r.unplaced)}</td><td className="px-sm py-1 text-outline">{r.location_id ? 'bin exists' : 'new bin'}</td>
            </tr>
          ))}</tbody></table>
        </div>
      )}
      <div className="flex gap-sm justify-end">
        <SecondaryButton type="button" onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton type="button" disabled={busy || !chosen.length} onClick={() => void go()}>{busy ? 'Putting away…' : `Put away ${fmtNumber(chosen.length)}`}</PrimaryButton>
      </div>
    </div>
  );
}

function Locations({ triggerToast, onOpenItem, items = [] }: { triggerToast: Toast; onOpenItem?: (s: string) => void; items?: Item[] }) {
  // The Code box offers the stock codes (a bin can be named after the part it holds), and takes anything typed.
  const itemByCode = useMemo(() => new Map(items.map((it) => [it.partNumber.toUpperCase(), it])), [items]);
  const may = canChange('/api/stock-locations');
  const [data, setData] = useState<{ locations: Location[]; unplaced: { units: number; items: number } } | null>(null);
  const [form, setForm] = useState<{ id?: number; code: string; name: string; notes: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [contents, setContents] = useState<any[] | null>(null);
  const [putting, setPutting] = useState<number | null>(null);
  const [onePer, setOnePer] = useState(false);

  const load = useCallback(async () => { try { setData(await api('/api/stock-locations')); } catch (e: any) { triggerToast(e.message, 'ERROR'); } }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (open === null) { setContents(null); return; }
    api(`/api/stock-locations/${open}/contents`).then(setContents).catch(() => setContents([]));
  }, [open]);

  const save = async () => {
    if (!form) return;
    try {
      const body = JSON.stringify({ code: form.code, name: form.name, notes: form.notes });
      const saved = form.id ? await api(`/api/stock-locations/${form.id}`, { method: 'PUT', body }) : await api('/api/stock-locations', { method: 'POST', body });
      setForm(null); await load();
      // Named after a stock code with stock to put away: ask straight away.
      if (!form.id && itemByCode.has(String(saved.code ?? '').toUpperCase())) setPutting(saved.id);
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const toggle = async (l: Location) => { try { await api(`/api/stock-locations/${l.id}`, { method: 'PUT', body: JSON.stringify({ active: !l.active }) }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } };
  const remove = async (l: Location) => {
    if (!(await confirmDialog({ title: 'Delete location', message: `Delete ${l.code}? Only an empty location can be deleted.`, confirmLabel: 'Delete', destructive: true }))) return;
    try { await api(`/api/stock-locations/${l.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  if (!data) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  return (
    <div className="space-y-md">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <p className="text-xs text-on-surface-variant max-w-[760px] leading-relaxed">
          Bins, shelves and racks where stock is kept. {fmtNumber(data.unplaced.units)} units on {fmtNumber(data.unplaced.items)} items aren't put away yet.
        </p>
        {may && <div className="flex gap-sm shrink-0">
          {data.unplaced.items > 0 && <SecondaryButton type="button" onClick={() => setOnePer(true)}>One bin per item</SecondaryButton>}
          <PrimaryButton type="button" icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setForm({ code: '', name: '', notes: '' })}>New location</PrimaryButton>
        </div>}
      </div>
      {onePer && <OneBinPerItem triggerToast={triggerToast} onCancel={() => setOnePer(false)} onDone={() => { setOnePer(false); void load(); }} />}
      {form && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md grid grid-cols-1 md:grid-cols-4 gap-sm items-end" data-testid="location-form">
          <label className="text-xs text-outline">Code<input className={`${input} w-full mt-1 font-mono`} list="location-code-options" value={form.code} onChange={(e) => { const code = e.target.value; const it = itemByCode.get(code.trim().toUpperCase()); setForm({ ...form, code, name: form.name || !it ? form.name : String(it.name ?? '') }); }} placeholder="A1-03, or pick a stock code" aria-label="Location code" /><datalist id="location-code-options">{items.map((it) => <option key={it.partNumber} value={it.partNumber}>{it.name}</option>)}</datalist></label>
          <label className="text-xs text-outline">Name<input className={`${input} w-full mt-1`} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Reel rack 1, shelf 3" aria-label="Location name" /></label>
          <label className="text-xs text-outline">Notes<input className={`${input} w-full mt-1`} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} aria-label="Location notes" /></label>
          <div className="flex gap-sm justify-end"><SecondaryButton type="button" onClick={() => setForm(null)}>Cancel</SecondaryButton><PrimaryButton type="button" onClick={() => void save()}>{form.id ? 'Save' : 'Add'}</PrimaryButton></div>
        </div>
      )}
      {data.locations.length === 0 ? <p className="text-xs text-on-surface-variant italic">No locations yet.</p> : (
        <div className="rounded-xl border border-outline-variant overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30">
              <th className="px-md py-2">Location</th><th className="px-md py-2">Items</th><th className="px-md py-2">Units</th><th className="px-md py-2">Notes</th><th className="px-md py-2"><span className="sr-only">Actions</span></th>
            </tr></thead>
            <tbody className="divide-y divide-outline-variant/30">
              {data.locations.map((l) => (
                <React.Fragment key={l.id}>
                  <tr className={l.active ? '' : 'opacity-50'} data-location={l.code}>
                    <td className="px-md py-2"><button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => setOpen(open === l.id ? null : l.id)}>{l.code}</button>{l.name && <span className="block text-[11px] text-on-surface-variant">{l.name}</span>}{!l.active && <span className="text-[10px] text-outline"> inactive</span>}</td>
                    <td className="px-md py-2 font-mono">{fmtNumber(l.items)}</td>
                    <td className="px-md py-2 font-mono">{fmtNumber(l.units)}</td>
                    <td className="px-md py-2 text-on-surface-variant">{l.notes}</td>
                    <td className="px-md py-2 text-right whitespace-nowrap">{may && <>
                      <button type="button" aria-label={`Edit ${l.code}`} className="p-1.5 rounded hover:bg-surface-container-high" onClick={() => setForm({ id: l.id, code: l.code, name: l.name ?? '', notes: l.notes ?? '' })}><Pencil className="w-3.5 h-3.5" /></button>
                      <button type="button" className="px-2 py-0.5 text-[10px] rounded hover:bg-surface-container-high" onClick={() => void toggle(l)}>{l.active ? 'Make inactive' : 'Make active'}</button>
                      {canChange('/api/stock-locations/1', 'DELETE') && l.units === 0 && <button type="button" aria-label={`Delete ${l.code}`} className="p-1.5 rounded hover:bg-error/10 text-error" onClick={() => void remove(l)}><Trash2 className="w-3.5 h-3.5" /></button>}
                    </>}</td>
                  </tr>
                  {l.item_serial && (l.item_unplaced ?? 0) > 0 && (
                    <tr><td colSpan={5} className="px-md pb-2">
                      {putting === l.id
                        ? <PutHere l={l} triggerToast={triggerToast} onCancel={() => setPutting(null)} onDone={() => { setPutting(null); void load(); if (open === l.id) setOpen(null); }} />
                        : <span className="text-[11px] text-on-surface-variant">{l.item_serial}: {fmtNumber(l.item_unplaced ?? 0)} not put away yet.{may && <> <button type="button" className="text-primary font-bold hover:underline" onClick={() => setPutting(l.id)}>Put away here</button></>}</span>}
                    </td></tr>
                  )}
                  {open === l.id && (
                    <tr><td colSpan={5} className="px-md py-2 bg-surface-container-high/30">
                      {!contents ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : contents.length === 0 ? <span className="text-[11px] text-outline">Empty.</span> : (
                        <table className="w-full text-[11px]"><tbody>{contents.map((b) => (
                          <tr key={b.id}><td className="pr-2">{onOpenItem ? <button type="button" className="font-mono text-primary hover:underline" onClick={() => onOpenItem(b.serial_number)}>{b.serial_number}</button> : b.serial_number}</td>
                            <td className="pr-2 text-on-surface-variant">{b.name}</td><td className="pr-2 font-mono">{fmtNumber(b.qty)}</td><td className="pr-2 text-outline">{b.lot ? `lot ${b.lot}` : ''}{b.date_code ? ` · DC ${b.date_code}` : ''}</td><td className="text-outline">{when(b.received_at)}</td></tr>
                        ))}</tbody></table>
                      )}
                    </td></tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const WHAT = (c: { scope: string; location_code: string | null; prefix: string | null }, n?: number) =>
  `${c.scope === 'location' ? (c.location_code ?? 'a deleted location') : c.scope === 'unplaced' ? 'Not put away yet' : c.scope === 'items' ? `${n ?? ''} chosen item${n === 1 ? '' : 's'}`.trim() : 'Everything'}${c.prefix ? ` (${c.prefix}…)` : ''}`;

/** One check: every line starts at what the system says; change what's different, then Confirm. */
function CountSheet({ id, triggerToast, onClose, onOpenItem }: { id: number; triggerToast: Toast; onClose: () => void; onOpenItem?: (s: string) => void }) {
  const may = canChange('/api/stock-counts');
  const [data, setData] = useState<{ count: Count; lines: CountLine[] } | null>(null);
  const [entered, setEntered] = useState<Record<number, string>>({});
  const [filter, setFilter] = useState('');
  const [add, setAdd] = useState({ serial: '', lot: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const d = await api(`/api/stock-counts/${id}`);
      setData(d);
      // Saved counts as they were; the rest start at what the system says.
      setEntered(Object.fromEntries(d.lines.map((l: CountLine) => [l.id, String(l.counted ?? l.now)])));
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  }, [id, triggerToast]);
  useEffect(() => { void load(); }, [load]);

  const saveAll = async () => api(`/api/stock-counts/${id}/lines`, { method: 'PUT', body: JSON.stringify({ lines: data!.lines.map((l) => ({ id: l.id, counted: entered[l.id] === '' ? null : entered[l.id] })) }) });
  const later = async () => {
    setBusy('save');
    try { await saveAll(); triggerToast('Saved. Come back to it from Earlier checks.', 'SUCCESS'); onClose(); } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const addLine = async () => {
    setBusy('add');
    try { await saveAll(); await api(`/api/stock-counts/${id}/lines`, { method: 'POST', body: JSON.stringify({ serialNumber: add.serial.trim(), lot: add.lot }) }); setAdd({ serial: '', lot: '' }); await load(); }
    catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const confirm = async () => {
    const diffs = data!.lines.filter((l) => entered[l.id] !== '' && Number(entered[l.id]) !== l.now);
    const list = diffs.slice(0, 8).map((l) => `${l.serial_number} ${Number(entered[l.id]) - l.now > 0 ? '+' : ''}${fmtNumber(Number(entered[l.id]) - l.now)}`).join(', ');
    if (!(await confirmDialog({
      title: 'Confirm the check',
      message: diffs.length ? `${fmtNumber(diffs.length)} line${diffs.length === 1 ? '' : 's'} differ from the system: ${list}${diffs.length > 8 ? ', …' : ''}. Stock will be corrected to what you counted, and the change recorded.` : 'Everything matches the system. It will be recorded as checked.',
      confirmLabel: 'Confirm',
    }))) return;
    setBusy('post');
    try {
      await saveAll();
      const r = await api(`/api/stock-counts/${id}/post`, { method: 'POST', body: '{}' });
      triggerToast(r.items.length ? `Done: ${fmtNumber(r.items.length)} item${r.items.length === 1 ? '' : 's'} corrected.` : 'Done: everything matched.', 'SUCCESS');
      onClose();
    } catch (e: any) { triggerToast(e.message, 'ERROR'); } finally { setBusy(null); }
  };
  const cancel = async () => {
    if (!(await confirmDialog({ title: 'Cancel this check', message: 'Nothing has been changed by it.', confirmLabel: 'Cancel it', destructive: true }))) return;
    try { await api(`/api/stock-counts/${id}/cancel`, { method: 'POST', body: '{}' }); onClose(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };

  const lines = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return (data?.lines ?? []).filter((l) => !q || l.serial_number.toLowerCase().includes(q) || String(l.name ?? '').toLowerCase().includes(q) || String(l.location_code ?? '').toLowerCase().includes(q));
  }, [data, filter]);
  if (!data) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const open = data.count.status === 'OPEN' && may;
  const differ = data.lines.filter((l) => entered[l.id] !== '' && Number(entered[l.id]) !== l.now).length;

  return (
    <div className="space-y-md" data-testid="count-sheet">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div>
          <p className="text-sm font-bold text-on-surface">Checking {WHAT(data.count, new Set(data.lines.map((l) => l.serial_number)).size)} <span className="text-outline font-normal text-xs">· {data.count.number} · {data.count.status.toLowerCase()}</span></p>
          <p className="text-[11px] text-outline">{open ? `Each line starts at what the system says. Change only what's different. ${differ ? `${fmtNumber(differ)} differ so far.` : 'All match so far.'}` : ''}</p>
        </div>
        <div className="flex gap-sm">
          <SecondaryButton type="button" onClick={onClose}>Back</SecondaryButton>
          {open && <>
            <SecondaryButton type="button" onClick={() => void cancel()}>Cancel</SecondaryButton>
            <SecondaryButton type="button" disabled={busy !== null} onClick={() => void later()} icon={busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>Finish later</SecondaryButton>
            <PrimaryButton type="button" disabled={busy !== null || !data.lines.length} onClick={() => void confirm()} icon={busy === 'post' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}>Confirm</PrimaryButton>
          </>}
        </div>
      </div>
      {data.lines.length > 8 && <div className="relative w-full sm:w-72"><Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-outline" /><input className={`${input} w-full pl-8 py-1.5 text-xs`} placeholder="Find an item…" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Find a line" /></div>}
      <div className="rounded-xl border border-outline-variant overflow-x-auto max-h-[60vh] overflow-y-auto custom-scrollbar">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 bg-surface-container-high"><tr className="text-[10px] text-outline uppercase tracking-wider">
            <th className="px-md py-2">Item</th><th className="px-md py-2">Where</th><th className="px-md py-2 text-right">System says</th><th className="px-md py-2 text-right">Actually there</th><th className="px-md py-2 text-right">Difference</th>
          </tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {lines.map((l) => {
              const v = entered[l.id] ?? '';
              const d = v === '' ? null : Number(v) - l.now;
              return (
                <tr key={l.id} data-count-line={l.serial_number} className={d ? 'bg-amber-500/5' : ''}>
                  <td className="px-md py-1.5">{onOpenItem ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(l.serial_number)}>{l.serial_number}</button> : <span className="font-mono font-bold">{l.serial_number}</span>}<span className="block text-[10px] text-on-surface-variant">{l.name}</span></td>
                  <td className="px-md py-1.5 text-on-surface-variant">{l.location_code ?? (l.lot ? '' : 'Not put away yet')}{l.lot ? `${l.location_code ? ' · ' : ''}lot ${l.lot}` : ''}{l.added && <span className="text-[10px] text-primary"> · added</span>}</td>
                  <td className="px-md py-1.5 text-right font-mono">{fmtNumber(l.now)}</td>
                  <td className="px-md py-1.5 text-right">{open
                    ? <input className={`${input} w-24 py-1 text-right font-mono ${d ? 'border-amber-500' : ''}`} inputMode="numeric" value={v} onFocus={(e) => e.target.select()} onChange={(e) => setEntered({ ...entered, [l.id]: e.target.value.replace(/[^0-9]/g, '') })} aria-label={`Actually there ${l.serial_number}`} />
                    : <span className="font-mono">{l.counted === null ? '—' : fmtNumber(l.counted)}</span>}</td>
                  <td className={`px-md py-1.5 text-right font-mono font-bold ${d === null || d === 0 ? 'text-outline' : d > 0 ? 'text-green-500' : 'text-error'}`}>{d === null ? '' : d === 0 ? '✓' : d > 0 ? `+${fmtNumber(d)}` : fmtNumber(d)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {open && (
        <div className="flex flex-wrap items-end gap-sm text-xs">
          <span className="text-outline">Found something that isn't listed?</span>
          <input className={`${input} py-1.5 text-xs font-mono`} placeholder="Stock code" value={add.serial} onChange={(e) => setAdd({ ...add, serial: e.target.value })} aria-label="Stock code found" />
          <input className={`${input} py-1.5 text-xs`} placeholder="Lot (optional)" value={add.lot} onChange={(e) => setAdd({ ...add, lot: e.target.value })} aria-label="Lot found" />
          <SecondaryButton type="button" disabled={!add.serial.trim() || busy !== null} onClick={() => void addLine()}>Add it</SecondaryButton>
        </div>
      )}
      {data.count.status === 'POSTED' && data.count.summary && (
        <p className="text-[11px] text-on-surface-variant">Confirmed {when(data.count.posted_at)}: {(data.count.summary.items ?? []).map((i: any) => `${i.serialNumber} ${i.change > 0 ? '+' : ''}${i.change}`).join(', ') || 'everything matched'}.</p>
      )}
    </div>
  );
}

function Counts({ triggerToast, onOpenItem, items = [] }: { triggerToast: Toast; onOpenItem?: (s: string) => void; items?: Item[] }) {
  const may = canChange('/api/stock-counts');
  const [counts, setCounts] = useState<Count[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [what, setWhat] = useState<'location' | 'items' | 'all'>('location');
  const [locationId, setLocationId] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [pick, setPick] = useState('');
  const [prefix, setPrefix] = useState('');
  const load = useCallback(async () => {
    try { setCounts(await api('/api/stock-counts')); setLocations((await api('/api/stock-locations')).locations); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);
  const known = useMemo(() => new Map(items.map((i) => [i.partNumber.toUpperCase(), i.partNumber])), [items]);
  const addPick = (v: string) => { const code = known.get(v.trim().toUpperCase()); if (code && !picked.includes(code)) setPicked([...picked, code]); setPick(''); };
  const remove = async (c: Count) => {
    if (!(await confirmDialog({ title: `Delete ${c.number}`, message: `Delete this ${c.status === 'OPEN' ? 'unfinished' : 'cancelled'} check? It never changed any stock.`, confirmLabel: 'Delete', destructive: true }))) return;
    try { await api(`/api/stock-counts/${c.id}`, { method: 'DELETE' }); await load(); } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  const start = async () => {
    try {
      const r = await api('/api/stock-counts', { method: 'POST', body: JSON.stringify({ scope: what, locationId, serials: picked, prefix: what === 'all' ? prefix : '' }) });
      setPicked([]); await load(); setOpen(r.id);
    } catch (e: any) { triggerToast(e.message, 'ERROR'); }
  };
  if (open !== null) return <CountSheet id={open} triggerToast={triggerToast} onOpenItem={onOpenItem} onClose={() => { setOpen(null); void load(); }} />;
  if (!counts) return <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>;
  const ready = what === 'location' ? !!locationId : what === 'items' ? picked.length > 0 : true;
  const unfinished = counts.filter((c) => c.status === 'OPEN');
  return (
    <div className="space-y-md">
      <p className="text-xs text-on-surface-variant">Check that what's really there matches the system. Every line starts with the system's amount, so you only change what's different, then Confirm.</p>
      {may && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md space-y-sm" data-testid="count-form">
          <div className="flex flex-wrap gap-1" role="radiogroup" aria-label="What to check">
            {([['location', 'A bin or shelf'], ['items', 'Some items'], ['all', 'Everything']] as const).map(([k, label]) => (
              <button key={k} type="button" role="radio" aria-checked={what === k} onClick={() => setWhat(k)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${what === k ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant hover:text-on-surface'}`}>{label}</button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-sm">
            {what === 'location' && (locations.filter((l) => l.active).length
              ? <select className={`${input} min-w-[240px]`} value={locationId} onChange={(e) => setLocationId(e.target.value)} aria-label="Bin to check">
                  <option value="">Choose the bin or shelf…</option>{locations.filter((l) => l.active).map((l) => <option key={l.id} value={l.id}>{l.code}{l.name ? ` · ${l.name}` : ''}</option>)}</select>
              : <span className="text-xs text-outline">No bins yet: add them under Locations.</span>)}
            {what === 'items' && (
              <div className="flex flex-wrap items-center gap-1">
                {picked.map((p) => <span key={p} className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-1 rounded text-xs font-mono">{p}<button type="button" aria-label={`Remove ${p}`} onClick={() => setPicked(picked.filter((x) => x !== p))}>×</button></span>)}
                <input className={`${input} w-56 font-mono`} list="check-item-codes" value={pick} placeholder="Type or pick a stock code"
                  onChange={(e) => { setPick(e.target.value); if (known.has(e.target.value.trim().toUpperCase())) addPick(e.target.value); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') addPick(pick); }} aria-label="Item to check" />
              </div>
            )}
            {what === 'all' && <input className={`${input} w-56 font-mono`} value={prefix} onChange={(e) => setPrefix(e.target.value)} placeholder="Only codes starting with… (optional)" aria-label="Stock code prefix" />}
            <PrimaryButton type="button" disabled={!ready} onClick={() => void start()} icon={<ClipboardList className="w-3.5 h-3.5" />}>Check</PrimaryButton>
          </div>
          <datalist id="check-item-codes">{items.map((i) => <option key={i.partNumber} value={i.partNumber}>{i.name}</option>)}</datalist>
        </div>
      )}
      {unfinished.length > 0 && <p className="text-xs text-amber-500">Unfinished: {unfinished.map((c) => <button key={c.id} type="button" className="underline mr-2" onClick={() => setOpen(c.id)}>{c.number} ({WHAT(c)})</button>)}</p>}
      {counts.length > 0 && (
        <details open={counts.length <= 5}>
          <summary className="cursor-pointer text-xs font-bold text-on-surface">Earlier checks ({fmtNumber(counts.length)})</summary>
          <div className="rounded-xl border border-outline-variant overflow-x-auto mt-sm">
            <table className="w-full text-left text-xs"><thead><tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30">
              <th className="px-md py-2">Check</th><th className="px-md py-2">What</th><th className="px-md py-2">Result</th><th className="px-md py-2">When</th><th className="px-md py-2"><span className="sr-only">Actions</span></th></tr></thead>
              <tbody className="divide-y divide-outline-variant/30">{counts.map((c) => (
                <tr key={c.id}><td className="px-md py-2"><button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => setOpen(c.id)}>{c.number}</button></td>
                  <td className="px-md py-2">{WHAT(c)}</td>
                  <td className="px-md py-2">{c.status === 'POSTED' ? <span className="text-green-500">{(c.summary?.items ?? []).length ? `${(c.summary.items as any[]).length} corrected` : 'all matched'}</span> : c.status === 'OPEN' ? <span className="text-primary">unfinished</span> : <span className="text-outline">cancelled</span>}</td>
                  <td className="px-md py-2 text-outline">{when(c.posted_at ?? c.created_at)}{c.created_by ? ` · ${c.created_by}` : ''}</td>
                  <td className="px-md py-2 text-right">{c.status !== 'POSTED' && canChange('/api/stock-counts/1', 'DELETE') && (
                    <button type="button" aria-label={`Delete ${c.number}`} title="Delete (it never changed any stock)" className="p-1.5 rounded hover:bg-error/10 text-error" onClick={() => void remove(c)}><Trash2 className="w-3.5 h-3.5" /></button>
                  )}</td></tr>
              ))}</tbody></table>
          </div>
        </details>
      )}
    </div>
  );
}

export default function StockPlacesView({ triggerToast, onOpenItem, items }: { triggerToast: Toast; onOpenItem?: (s: string) => void; items?: Item[] }) {
  const [tab, setTab] = useState<'locations' | 'counts' | 'lots'>('locations');
  const tabs = [
    { key: 'locations' as const, label: 'Locations', icon: <MapPin className="w-3.5 h-3.5" /> },
    { key: 'counts' as const, label: 'Check stock', icon: <ClipboardList className="w-3.5 h-3.5" /> },
    { key: 'lots' as const, label: 'Lot tracing', icon: <Search className="w-3.5 h-3.5" /> },
  ];
  return (
    <div className="p-container-margin space-y-md max-w-7xl mx-auto w-full">
      <div>
        <h3 className="font-headline-sm text-lg text-on-surface">Locations &amp; counts</h3>
        <p className="text-on-surface-variant text-xs">Where stock is kept, checking it, and which lots went where.</p>
      </div>
      <div className="flex gap-1 border-b border-outline-variant/30">
        {tabs.map((t) => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 ${tab === t.key ? 'text-primary border-primary' : 'text-on-surface-variant border-transparent hover:text-on-surface'}`}>{t.icon}{t.label}</button>
        ))}
      </div>
      <div className="bg-surface-container border border-outline-variant rounded-xl p-lg">
        {tab === 'locations' && <Locations triggerToast={triggerToast} onOpenItem={onOpenItem} items={items} />}
        {tab === 'counts' && <Counts triggerToast={triggerToast} onOpenItem={onOpenItem} items={items} />}
        {tab === 'lots' && <LotTrace triggerToast={triggerToast} onOpenItem={onOpenItem} />}
      </div>
    </div>
  );
}

