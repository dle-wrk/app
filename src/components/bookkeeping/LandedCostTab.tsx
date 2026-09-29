// Landed-cost surface. Batch a set of goods bills together with their
// freight / duty / bank addon bills, preview the per-unit allocation,
// then post. Posting rewrites inventory.current_cost_dollar for every
// affected part and books the addon totals as a DR Inventory / CR
// Freight-Expense adjustment journal.

import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Package, CheckCircle2, Trash2 } from 'lucide-react';
import {
  ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate,
  apiGet, apiPost, apiDelete,
  PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard,
} from './shared';

export const LandedCostTab: React.FC<ModuleDataProps> = ({ triggerToast, bills }) => {
  const [batches, setBatches] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [viewing, setViewing] = useState<any | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const list = await apiGet('/api/landed-cost-batches');
      setBatches(Array.isArray(list) ? list : []);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to load batches', 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const open = async (id: number) => {
    try {
      const full = await apiGet(`/api/landed-cost-batches/${id}`);
      setViewing(full);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to load batch', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard
        title="Landed Cost Allocations"
        badge={`${batches.length} batch${batches.length === 1 ? '' : 'es'}`}
        actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setCreating(true)}>New Batch</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Batch #</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Method</th>
                <th className="px-lg py-sm">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {batches.map(b => (
                <tr key={b.id} className="hover:bg-surface-variant/20 cursor-pointer" onClick={() => open(b.id)}>
                  <td className="px-lg py-sm font-mono text-primary font-bold">{b.batchNumber}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(b.batchDate)}</td>
                  <td className="px-lg py-sm text-outline">{b.allocationMethod}</td>
                  <td className="px-lg py-sm"><StatusPill status={b.status} /></td>
                </tr>
              ))}
              {!loading && batches.length === 0 && (
                <EmptyState message="No landed-cost batches yet. Create one to allocate freight and duty across received stock." colSpan={4} />
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {creating && (
        <CreateModal
          bills={bills || []}
          triggerToast={triggerToast}
          onClose={() => setCreating(false)}
          onCreated={async (id) => { setCreating(false); await load(); await open(id); }}
        />
      )}

      {viewing && (
        <ViewModal
          batch={viewing}
          triggerToast={triggerToast}
          onClose={() => setViewing(null)}
          onChanged={async () => { const full = await apiGet(`/api/landed-cost-batches/${viewing.id}`); setViewing(full); await load(); }}
        />
      )}
    </div>
  );
};

const CreateModal: React.FC<{
  bills: any[];
  triggerToast: (m: string, t?: any) => void;
  onClose: () => void;
  onCreated: (id: number) => void;
}> = ({ bills, triggerToast, onClose, onCreated }) => {
  const [batchDate, setBatchDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<'BY_VALUE' | 'BY_QTY'>('BY_VALUE');
  const [goodsSel, setGoodsSel] = useState<Set<number>>(new Set());
  const [addonSel, setAddonSel] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const eligibleBills = useMemo(() => (bills || []).filter((b: any) => b.status !== 'DRAFT' && b.status !== 'VOID'), [bills]);

  const submit = async () => {
    if (goodsSel.size === 0 || Object.keys(addonSel).length === 0) {
      triggerToast('Pick at least one goods bill and one addon (freight/duty) bill.', 'ERROR');
      return;
    }
    setSaving(true);
    try {
      const created = await apiPost('/api/landed-cost-batches', {
        batchDate,
        allocationMethod: method,
        goodsBillIds: Array.from(goodsSel),
        addonBills: Object.entries(addonSel).map(([id, costType]) => ({ billId: Number(id), costType })),
        notes: notes || undefined,
      });
      onCreated(created.id);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to create batch', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Landed-Cost Batch" subtitle="Bolt freight / duty / bank charges onto received-goods bills so per-unit inventory cost reflects the true landed price." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid grid-cols-3 gap-md mb-md">
        <div><FieldLabel>Batch date</FieldLabel><input type="date" className={inputClass} value={batchDate} onChange={(e) => setBatchDate(e.target.value)} /></div>
        <div>
          <FieldLabel>Allocation</FieldLabel>
          <select className={selectClass} value={method} onChange={(e) => setMethod(e.target.value as any)}>
            <option value="BY_VALUE">By value (proportional to line total)</option>
            <option value="BY_QTY">By quantity (per unit)</option>
          </select>
        </div>
        <div><FieldLabel>Notes</FieldLabel><input className={inputClass} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Optional" /></div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
        <div>
          <div className="text-xs font-bold text-outline uppercase mb-2">Goods bills (received stock)</div>
          <div className="max-h-72 overflow-y-auto rounded border border-outline-variant/40">
            {eligibleBills.map((b: any) => (
              <label key={b.id} className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-outline-variant/20 cursor-pointer ${goodsSel.has(b.id) ? 'bg-primary/10' : 'hover:bg-surface-variant/20'}`}>
                <input type="checkbox" checked={goodsSel.has(b.id)} onChange={(e) => {
                  const next = new Set(goodsSel);
                  if (e.target.checked) { next.add(b.id); const a = { ...addonSel }; delete a[b.id]; setAddonSel(a); }
                  else next.delete(b.id);
                  setGoodsSel(next);
                }} />
                <span className="font-mono text-primary font-bold">{b.billNumber}</span>
                <span className="text-outline">·</span>
                <span className="truncate flex-1">{b.supplierName || '—'}</span>
                <span className="font-mono">{fmtMoney(b.total, b.currency)}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-bold text-outline uppercase mb-2">Addon bills (freight / duty / bank)</div>
          <div className="max-h-72 overflow-y-auto rounded border border-outline-variant/40">
            {eligibleBills.map((b: any) => {
              const picked = addonSel[b.id];
              const disabled = goodsSel.has(b.id);
              return (
                <div key={b.id} className={`flex items-center gap-2 px-3 py-1.5 text-xs border-b border-outline-variant/20 ${picked ? 'bg-secondary/10' : ''} ${disabled ? 'opacity-40' : ''}`}>
                  <input
                    type="checkbox"
                    checked={!!picked}
                    disabled={disabled}
                    onChange={(e) => {
                      const next = { ...addonSel };
                      if (e.target.checked) next[b.id] = 'FREIGHT';
                      else delete next[b.id];
                      setAddonSel(next);
                    }}
                  />
                  <span className="font-mono text-primary font-bold">{b.billNumber}</span>
                  <span className="text-outline">·</span>
                  <span className="truncate flex-1">{b.supplierName || '—'}</span>
                  <span className="font-mono">{fmtMoney(b.total, b.currency)}</span>
                  {picked && (
                    <select className="text-[10px] bg-surface-container-low border border-outline-variant/40 rounded px-1 py-0.5" value={picked} onChange={(e) => setAddonSel({ ...addonSel, [b.id]: e.target.value })}>
                      <option value="FREIGHT">Freight</option>
                      <option value="DUTY">Duty</option>
                      <option value="BANK">Bank</option>
                      <option value="OTHER">Other</option>
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose} disabled={saving}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving || goodsSel.size === 0 || Object.keys(addonSel).length === 0}>{saving ? 'Creating…' : 'Create batch'}</PrimaryButton>
      </div>
    </Modal>
  );
};

const ViewModal: React.FC<{
  batch: any;
  triggerToast: (m: string, t?: any) => void;
  onClose: () => void;
  onChanged: () => void;
}> = ({ batch, triggerToast, onClose, onChanged }) => {
  const [preview, setPreview] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (batch.status !== 'DRAFT') return;
    apiPost(`/api/landed-cost-batches/${batch.id}/preview`, {}).then(setPreview).catch(() => {});
  }, [batch.id, batch.status]);

  const doPost = async () => {
    setBusy(true);
    try {
      const r = await apiPost(`/api/landed-cost-batches/${batch.id}/post`, {});
      triggerToast(`Posted ${batch.batchNumber} — allocated ${r.totalAddon.toFixed(2)} across ${preview?.lines?.length || 0} lines.`);
      onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to post', 'ERROR');
    } finally {
      setBusy(false);
    }
  };
  const doDelete = async () => {
    if (!window.confirm('Delete this draft batch?')) return;
    try {
      await apiDelete(`/api/landed-cost-batches/${batch.id}`);
      triggerToast('Batch deleted.');
      onClose();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to delete', 'ERROR');
    }
  };

  const lines = batch.status === 'DRAFT' ? preview?.lines || [] : batch.lines || [];

  return (
    <Modal title={batch.batchNumber} subtitle={`${fmtDate(batch.batchDate)} · ${batch.allocationMethod}`} onClose={onClose} maxWidth="max-w-4xl">
      <div className="flex items-center gap-2 mb-md flex-wrap">
        <StatusPill status={batch.status} />
        {batch.postedAt && <span className="text-[10px] text-outline">Posted {fmtDate(batch.postedAt)}</span>}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-md mb-md">
        <div>
          <div className="text-xs font-bold text-outline uppercase mb-1">Goods bills</div>
          <div className="space-y-1">
            {(batch.goodsBills || []).map((b: any) => (
              <div key={b.bill_id} className="text-xs bg-surface-container-low border border-outline-variant/40 rounded px-2 py-1 flex justify-between">
                <span><span className="font-mono text-primary font-bold">{b.bill_number}</span> · {b.supplier || '—'}</span>
                <span className="font-mono">{fmtMoney(b.total)}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-bold text-outline uppercase mb-1">Addon bills</div>
          <div className="space-y-1">
            {(batch.addonBills || []).map((b: any) => (
              <div key={b.bill_id} className="text-xs bg-surface-container-low border border-outline-variant/40 rounded px-2 py-1 flex justify-between">
                <span><span className="font-mono text-secondary font-bold">{b.bill_number}</span> · {b.cost_type} · {b.supplier || '—'}</span>
                <span className="font-mono">{fmtMoney(b.total)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {(preview || batch.status !== 'DRAFT') && (
        <div className="rounded-lg border border-outline-variant/40 mb-md overflow-hidden">
          <div className="bg-surface-container-high/50 px-3 py-1.5 text-[10px] uppercase font-bold text-outline flex justify-between">
            <span>Per-line allocation</span>
            {preview && <span>Total addon {fmtMoney(preview.totalAddon)} · Allocated {fmtMoney(preview.allocatedSum)}{Math.abs(preview.rounding) > 0.005 ? ` · Δ ${fmtMoney(preview.rounding)}` : ''}</span>}
          </div>
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-outline text-[10px] uppercase border-b border-outline-variant/40">
                <th className="py-1.5 px-3">Part</th>
                <th className="py-1.5 px-3 text-right">Qty</th>
                <th className="py-1.5 px-3 text-right">Orig unit cost</th>
                <th className="py-1.5 px-3 text-right">Allocated</th>
                <th className="py-1.5 px-3 text-right">New unit cost</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l: any, idx: number) => (
                <tr key={l.billItemId || l.id || idx} className="border-t border-outline-variant/20">
                  <td className="py-1.5 px-3 font-mono text-primary">{l.partNumber}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{l.quantity}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{Number(l.originalUnitCost || 0).toFixed(4)}</td>
                  <td className="py-1.5 px-3 text-right font-mono">{fmtMoney(l.allocatedShare ?? l.allocatedAddon)}</td>
                  <td className="py-1.5 px-3 text-right font-mono font-bold text-green-400">{Number(l.newUnitCost || 0).toFixed(4)}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr><td colSpan={5} className="py-4 text-center text-outline italic">No line items on the selected goods bills.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-md border-t border-outline-variant/20">
        {batch.status === 'DRAFT' && (
          <>
            <DangerButton icon={<Trash2 className="w-3.5 h-3.5" />} onClick={doDelete}>Delete draft</DangerButton>
            <PrimaryButton icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={doPost} disabled={busy || lines.length === 0}>{busy ? 'Posting…' : 'Post allocation'}</PrimaryButton>
          </>
        )}
      </div>
    </Modal>
  );
};
