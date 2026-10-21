// Auto-PO settings and checks (server: src/lib/autoPoRoutes.ts, rules:
// src/lib/autoPo.ts). Each watched item has a reorder point and a minimum
// level: at or below the reorder point, Check now drafts a purchase order
// back up to the minimum. Check now always shows what it would draft first.
// Used on the Auto-PO Config page and in Automation > Auto-PO.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, Play, Trash2, Pencil, X, ShoppingCart } from 'lucide-react';
import type { Item, Supplier } from '../types';
import { canChange } from '../lib/changeAccess';
import { confirmDialog } from '../lib/confirmDialog';
import { fmtNumber, fmtUSD } from '../lib/formatMoney';
import { PrimaryButton, SecondaryButton } from './bookkeeping/shared';

interface Setting { id: number; componentId: string; name: string | null; stock: number | null; minStockLevel: number; autoPOThreshold: number; preferredSupplier: string | null; autoApprove: boolean; enabled: boolean; due: boolean }
interface Line { partNumber: string; name: string; stock: number; threshold: number; minLevel: number; quantity: number; unitPrice: number; supplierReason: string }
interface Plan { groups: Array<{ supplierId: string | null; supplierName: string | null; status: string; lines: Line[] }>; skipped: Array<{ partNumber: string; reason: string }>; created: Array<{ poNumber: string; supplier: string | null; status: string; lines: number }> }

type Toast = (msg: string, type?: string) => void;
const EMPTY = { componentIds: [] as string[], minStockLevel: '', autoPOThreshold: '', preferredSupplier: '', autoApprove: false };

export default function AutoPoPanel({ triggerToast, items = [], suppliers = [] }: { triggerToast: Toast; items?: Item[]; suppliers?: Supplier[] }) {
  const may = canChange('/api/auto-po-config');
  const mayRemove = canChange('/api/auto-po-config/1', 'DELETE');
  const [settings, setSettings] = useState<Setting[] | null>(null);
  const [form, setForm] = useState<typeof EMPTY | null>(null);
  const [editing, setEditing] = useState<Setting | null>(null);
  const [search, setSearch] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auto-po-config');
      const body = await res.json().catch(() => []);
      if (!res.ok) throw new Error(body.error || res.statusText);
      setSettings(body);
    } catch (e: any) { triggerToast(`Could not load the Auto-PO settings: ${e?.message || e}`, 'ERROR'); setSettings([]); }
  }, [triggerToast]);
  useEffect(() => { void load(); }, [load]);

  const supplierName = (id: string | null) => (id ? suppliers.find((s) => String(s.id) === String(id))?.name ?? id : null);
  const watched = new Set((settings ?? []).map((s) => s.componentId));
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return items.filter((i) => i.partNumber.toLowerCase().includes(q) || String(i.name ?? '').toLowerCase().includes(q)).slice(0, 12);
  }, [items, search]);

  const openNew = () => { setEditing(null); setForm({ ...EMPTY }); setSearch(''); };
  const openEdit = (s: Setting) => {
    setEditing(s);
    setForm({ componentIds: [s.componentId], minStockLevel: String(s.minStockLevel), autoPOThreshold: String(s.autoPOThreshold), preferredSupplier: s.preferredSupplier ?? '', autoApprove: s.autoApprove });
  };

  const save = async () => {
    if (!form) return;
    setBusy('save');
    try {
      const body = { minStockLevel: Number(form.minStockLevel), autoPOThreshold: Number(form.autoPOThreshold), preferredSupplier: form.preferredSupplier, autoApprove: form.autoApprove };
      const res = editing
        ? await fetch(`/api/auto-po-config/${editing.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await fetch('/api/auto-po-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, componentIds: form.componentIds }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { triggerToast(out.error || 'Could not save.', 'ERROR'); return; }
      triggerToast(editing ? `${editing.componentId} updated.` : `${fmtNumber(out.saved)} item${out.saved === 1 ? '' : 's'} now watched.`, 'SUCCESS');
      setForm(null); setEditing(null); setPlan(null);
      await load();
    } finally { setBusy(null); }
  };

  const toggle = async (s: Setting) => {
    setBusy(`t${s.id}`);
    try {
      const res = await fetch(`/api/auto-po-config/${s.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !s.enabled }) });
      if (!res.ok) { triggerToast((await res.json().catch(() => ({}))).error || 'Could not change it.', 'ERROR'); return; }
      await load();
    } finally { setBusy(null); }
  };

  const remove = async (s: Setting) => {
    if (!(await confirmDialog({ title: 'Stop watching', message: `Stop watching ${s.componentId}? Purchase orders already drafted stay.`, confirmLabel: 'Stop watching', destructive: true }))) return;
    const res = await fetch(`/api/auto-po-config/${s.id}`, { method: 'DELETE' });
    if (!res.ok) { triggerToast((await res.json().catch(() => ({}))).error || 'Could not remove it.', 'ERROR'); return; }
    await load();
  };

  const preview = async () => {
    setBusy('check');
    try {
      const res = await fetch('/api/auto-po-config/preview');
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { triggerToast(out.error || 'Could not check.', 'ERROR'); return; }
      setPlan(out);
    } finally { setBusy(null); }
  };

  const draft = async () => {
    setBusy('draft');
    try {
      const res = await fetch('/api/automation/run-auto-po', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) { triggerToast(out.error || 'Could not draft the purchase orders.', 'ERROR'); return; }
      const made: Plan['created'] = out.created ?? [];
      triggerToast(made.length ? `Drafted ${made.map((c) => `${c.poNumber}${c.supplier ? ` (${c.supplier})` : ''}`).join(', ')}. Find them under Purchase Orders.` : 'Nothing to order now.', made.length ? 'SUCCESS' : 'INFO');
      setPlan(null);
    } finally { setBusy(null); }
  };

  const linesDue = plan?.groups.reduce((n, g) => n + g.lines.length, 0) ?? 0;
  const input = 'w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface';

  return (
    <div className="space-y-md" data-testid="auto-po">
      <div className="flex flex-col md:flex-row md:items-start justify-between gap-md">
        <p className="text-xs text-on-surface-variant max-w-[720px] leading-relaxed">
          Watch the items you want reordered. When one is at or below its <strong>reorder point</strong>, <strong>Check now</strong> drafts a purchase order back up to its
          <strong> minimum level</strong>, one per supplier, and shows it to you first. Nothing is ordered on its own, and an item with a purchase order already open is skipped.
          Supplier: the one you choose here, else the item's Supplier field, else the fastest of the suppliers it has part numbers for.
        </p>
        <div className="flex gap-sm shrink-0">
          <SecondaryButton type="button" onClick={() => void preview()} disabled={busy !== null || !settings?.length}
            icon={busy === 'check' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}>Check now</SecondaryButton>
          {may && <PrimaryButton type="button" onClick={openNew} disabled={busy !== null} icon={<Plus className="w-3.5 h-3.5" />}>Watch items</PrimaryButton>}
        </div>
      </div>

      {plan && (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-md space-y-sm" data-testid="auto-po-plan">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <p className="text-sm font-bold text-on-surface flex items-center gap-2"><ShoppingCart className="w-4 h-4 text-primary" />
              {linesDue ? `${fmtNumber(linesDue)} item${linesDue === 1 ? '' : 's'} to reorder, on ${fmtNumber(plan.groups.length)} purchase order${plan.groups.length === 1 ? '' : 's'}` : 'Nothing is at its reorder point.'}
            </p>
            <div className="flex gap-sm">
              <SecondaryButton type="button" onClick={() => setPlan(null)}>Close</SecondaryButton>
              {may && linesDue > 0 && <PrimaryButton type="button" onClick={() => void draft()} disabled={busy !== null}
                icon={busy === 'draft' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>Draft {fmtNumber(plan.groups.length)} purchase order{plan.groups.length === 1 ? '' : 's'}</PrimaryButton>}
            </div>
          </div>
          {plan.groups.map((g, gi) => (
            <div key={gi} className="rounded-lg border border-outline-variant bg-surface-container p-sm">
              <p className="text-xs font-bold text-on-surface">{g.supplierName ?? 'No supplier yet'} <span className="text-outline font-normal">· {g.status === 'SENT' ? 'marked Sent (auto-approve)' : 'Draft'}</span></p>
              <table className="w-full text-[11px] mt-1">
                <tbody>
                  {g.lines.map((l) => (
                    <tr key={l.partNumber}>
                      <td className="pr-2 font-mono font-bold text-primary">{l.partNumber}</td>
                      <td className="pr-2 text-on-surface-variant">{l.name}</td>
                      <td className="pr-2 whitespace-nowrap">stock {fmtNumber(l.stock)} (reorder at {fmtNumber(l.threshold)})</td>
                      <td className="pr-2 font-bold whitespace-nowrap">order {fmtNumber(l.quantity)}</td>
                      <td className="pr-2 whitespace-nowrap">{fmtUSD(l.unitPrice, 3)} each</td>
                      <td className="text-outline">{l.supplierReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {plan.skipped.length > 0 && <p className="text-[11px] text-amber-500">Skipped: {plan.skipped.map((s) => `${s.partNumber} (${s.reason})`).join('; ')}</p>}
          <p className="text-[10px] text-outline">Prices are each item's last cost; check them on the purchase order before sending it.</p>
        </div>
      )}

      {form && (
        <div className="rounded-xl border border-outline-variant bg-surface-container-high p-md space-y-md" data-testid="auto-po-form">
          <div className="flex items-center justify-between">
            <p className="text-sm font-bold text-on-surface">{editing ? `Change ${editing.componentId}` : 'Watch items'}</p>
            <button type="button" aria-label="Close" onClick={() => { setForm(null); setEditing(null); }} className="p-1 text-outline hover:text-on-surface"><X className="w-4 h-4" /></button>
          </div>
          {!editing && (
            <div>
              <label className="text-xs font-bold text-outline uppercase block mb-1">Items</label>
              <div className="flex flex-wrap gap-1 mb-1">
                {form.componentIds.map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-0.5 rounded text-xs font-mono">
                    {id}<button type="button" aria-label={`Remove ${id}`} onClick={() => setForm({ ...form, componentIds: form.componentIds.filter((x) => x !== id) })}><X className="w-3 h-3" /></button>
                  </span>
                ))}
              </div>
              <input className={input} placeholder="Search stock code or name…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search items" />
              {matches.length > 0 && (
                <div className="mt-1 max-h-48 overflow-y-auto rounded border border-outline-variant bg-surface-container">
                  {matches.map((i) => (
                    <button key={i.partNumber} type="button" className="w-full text-left px-3 py-1.5 text-xs hover:bg-surface-container-highest flex justify-between gap-2"
                      onClick={() => { if (!form.componentIds.includes(i.partNumber)) setForm({ ...form, componentIds: [...form.componentIds, i.partNumber] }); setSearch(''); }}>
                      <span className="font-mono text-on-surface">{i.partNumber}</span>
                      <span className="text-outline truncate">{i.name} · stock {fmtNumber(i.stockLevel ?? 0)}{watched.has(i.partNumber) ? ' · watched (replaces its setting)' : ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div>
              <label className="text-xs font-bold text-outline uppercase block mb-1">Reorder point</label>
              <input className={input} inputMode="numeric" value={form.autoPOThreshold} onChange={(e) => setForm({ ...form, autoPOThreshold: e.target.value })} aria-label="Reorder point" placeholder="e.g. 100" />
              <p className="text-[10px] text-outline mt-1">Reorder when stock is at or below this.</p>
            </div>
            <div>
              <label className="text-xs font-bold text-outline uppercase block mb-1">Minimum level</label>
              <input className={input} inputMode="numeric" value={form.minStockLevel} onChange={(e) => setForm({ ...form, minStockLevel: e.target.value })} aria-label="Minimum level" placeholder="e.g. 500" />
              <p className="text-[10px] text-outline mt-1">Order enough to bring stock back up to this.</p>
            </div>
            <div>
              <label className="text-xs font-bold text-outline uppercase block mb-1">Supplier</label>
              <select className={input} value={form.preferredSupplier} onChange={(e) => setForm({ ...form, preferredSupplier: e.target.value })} aria-label="Supplier">
                <option value="">Automatic</option>
                {[...suppliers].sort((a, b) => a.name.localeCompare(b.name)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              <p className="text-[10px] text-outline mt-1">Automatic: the item's Supplier field, else its fastest supplier.</p>
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm text-on-surface cursor-pointer">
            <input type="checkbox" checked={form.autoApprove} onChange={(e) => setForm({ ...form, autoApprove: e.target.checked })} className="w-4 h-4" />
            Mark its purchase orders as Sent instead of Draft (you still place the order with the supplier)
          </label>
          <div className="flex justify-end gap-sm">
            <SecondaryButton type="button" onClick={() => { setForm(null); setEditing(null); }}>Cancel</SecondaryButton>
            <PrimaryButton type="button" onClick={() => void save()} disabled={busy !== null || (!editing && !form.componentIds.length)}
              icon={busy === 'save' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined}>{editing ? 'Save' : `Watch ${fmtNumber(form.componentIds.length)}`}</PrimaryButton>
          </div>
        </div>
      )}

      {settings === null ? (
        <p className="text-xs text-outline flex items-center gap-2"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading…</p>
      ) : settings.length === 0 ? (
        <p className="text-xs text-on-surface-variant italic">No items are watched yet.{may ? ' Use Watch items to choose some.' : ''}</p>
      ) : (
        <div className="rounded-xl border border-outline-variant overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-[10px] text-outline uppercase tracking-wider bg-surface-container-high/30">
                <th className="px-md py-2">Item</th><th className="px-md py-2">Stock</th><th className="px-md py-2">Reorder point</th>
                <th className="px-md py-2">Minimum</th><th className="px-md py-2">Supplier</th><th className="px-md py-2">Status</th><th className="px-md py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {settings.map((s) => (
                <tr key={s.id} data-setting={s.componentId}>
                  <td className="px-md py-2"><span className="font-mono font-bold text-primary">{s.componentId}</span>{s.name && <span className="block text-[11px] text-on-surface-variant">{s.name}</span>}</td>
                  <td className={`px-md py-2 font-mono ${s.due ? 'text-error font-bold' : ''}`}>{s.stock == null ? 'not in inventory' : fmtNumber(s.stock)}{s.due && s.enabled ? ' · due' : ''}</td>
                  <td className="px-md py-2 font-mono">{fmtNumber(s.autoPOThreshold)}</td>
                  <td className="px-md py-2 font-mono">{fmtNumber(s.minStockLevel)}</td>
                  <td className="px-md py-2">{supplierName(s.preferredSupplier) ?? <span className="text-outline">Automatic</span>}{s.autoApprove && <span className="block text-[10px] text-outline">marks POs Sent</span>}</td>
                  <td className="px-md py-2">
                    {may ? (
                      <button type="button" onClick={() => void toggle(s)} disabled={busy !== null}
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${s.enabled ? 'bg-green-500/10 text-green-400' : 'bg-surface-container-highest text-outline'}`}
                        title={s.enabled ? 'Pause' : 'Resume'}>{s.enabled ? 'ON' : 'PAUSED'}</button>
                    ) : <span className="text-[10px] font-bold">{s.enabled ? 'ON' : 'PAUSED'}</span>}
                  </td>
                  <td className="px-md py-2 text-right whitespace-nowrap">
                    {may && <>
                      <button type="button" aria-label={`Change ${s.componentId}`} onClick={() => openEdit(s)} className="p-1.5 rounded hover:bg-surface-container-high text-on-surface-variant"><Pencil className="w-3.5 h-3.5" /></button>
                      {mayRemove && <button type="button" aria-label={`Stop watching ${s.componentId}`} onClick={() => void remove(s)} className="p-1.5 rounded hover:bg-error/10 text-error"><Trash2 className="w-3.5 h-3.5" /></button>}
                    </>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
