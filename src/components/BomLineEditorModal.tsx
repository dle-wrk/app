import React, { useEffect, useState } from 'react';
import { Pencil, Save, Plus, Trash2, Loader2, X, AlertTriangle } from 'lucide-react';
import { useEscapeKey } from '../lib/useEscapeKey';

// Admin-only modal for editing the raw BOM rows behind a single audit
// line. The audit table aggregates by stock code — the same part can
// come from multiple source rows (different designators, or duplicates
// spread across legacy tables) — so this modal surfaces each of those
// source rows as an editable entry rather than pretending there's just
// one. Legacy tables (db_bom, db_bom_tcu06, db_bom_ncu04,
// db_bom_loradongle) don't carry description/comment/footprint/libref,
// so those fields are disabled on rows sourced from them; qty and
// designator remain editable. New rows always land in the canonical
// per-project table.
//
// Save writes atomically via POST /api/kit-booking/bom/:projectId; on
// success the parent re-runs the audit so P&P Kit Booking, BOM Manager
// and every other manufacturing view (all read live from the same
// tables) reflect the change on their next fetch.

// A row shape identical to what the server returns from the list
// endpoint. `_isNew` and `_isDeleted` are client-only flags — the
// server infers the operation from which array (updates/deletes/
// inserts) the row lands in.
interface BomRow {
  id: string;
  _table: string;
  _ctid: string;
  stockCode: string;
  quantity: number;
  designator: string;
  description: string;
  comment: string;
  footprint: string;
  libref: string;
  // Canonical values from the inventory table. Legacy source tables
  // (db_bom etc.) don't carry description/comment/footprint at all, so
  // the audit view already falls back to inventory for those columns —
  // we surface the same fallback here so the editor is honest about
  // what will show downstream instead of rendering an empty field.
  inventoryDescription?: string;
  inventoryComment?: string;
  inventoryFootprint?: string;
  _isNew?: boolean;
  _isDeleted?: boolean;
  _isDirty?: boolean;
}

const LEGACY_TABLES = new Set(['db_bom', 'db_bom_tcu06', 'db_bom_ncu04', 'db_bom_loradongle']);

interface Props {
  projectId: number;
  // The audit line the admin double-clicked. When null, we are in
  // "add a new BOM line" mode — the modal opens with one blank row and
  // no fetch.
  stockCode: string | null;
  onClose: () => void;
  onSaved: () => void;
  triggerToast: (msg: string, type?: string) => void;
}

export default function BomLineEditorModal({ projectId, stockCode, onClose, onSaved, triggerToast }: Props) {
  const [rows, setRows] = useState<BomRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);

  useEscapeKey(() => { if (!saving) onClose(); }, true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        if (stockCode === null) {
          // Fresh add — one blank row, admin fills in the stockCode.
          if (!cancelled) setRows([blankRow()]);
          return;
        }
        const res = await fetch(`/api/kit-booking/bom/${projectId}`);
        if (!res.ok) throw new Error(`Failed to load BOM (${res.status})`);
        const data: BomRow[] = await res.json();
        const matches = data.filter(r => r.stockCode.trim().toLowerCase() === stockCode.trim().toLowerCase());
        if (!cancelled) {
          setRows(matches.length > 0 ? matches : [{ ...blankRow(), stockCode }]);
        }
      } catch (err: any) {
        if (!cancelled) triggerToast(`Failed to load BOM rows: ${err.message}`, 'ERROR');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [projectId, stockCode, triggerToast]);

  function blankRow(): BomRow {
    return {
      id: `new-${Math.random().toString(36).slice(2, 10)}`,
      _table: `db_bom_project_${projectId}`,
      _ctid: '',
      stockCode: '',
      quantity: 1,
      designator: '',
      description: '',
      comment: '',
      footprint: '',
      libref: '',
      _isNew: true,
      _isDirty: true,
    };
  }

  const patch = (id: string, changes: Partial<BomRow>) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, ...changes, _isDirty: true } : r));
  };

  const markDeleted = (id: string) => {
    setRows(prev => prev.flatMap(r => {
      if (r.id !== id) return [r];
      if (r._isNew) return []; // never persisted — just drop it
      return [{ ...r, _isDeleted: true }];
    }));
    setConfirmingDelete(null);
  };

  const undoDelete = (id: string) => {
    setRows(prev => prev.map(r => r.id === id ? { ...r, _isDeleted: false } : r));
  };

  const addRow = () => {
    // Prefill stockCode from the first existing row so the admin
    // doesn't retype it for a second designator entry.
    const seed = rows.find(r => !r._isDeleted);
    const fresh = blankRow();
    if (seed) {
      fresh.stockCode = seed.stockCode;
      fresh.description = seed.description;
    }
    setRows(prev => [...prev, fresh]);
  };

  const anyChanges = rows.some(r => r._isDirty || r._isDeleted);
  const anyBlockingErrors = rows.some(r => !r._isDeleted && (!r.stockCode.trim() || r.quantity < 0));

  const save = async () => {
    if (!anyChanges || anyBlockingErrors) return;
    setSaving(true);
    try {
      const inserts = rows.filter(r => r._isNew && !r._isDeleted).map(toPayload);
      const updates = rows
        .filter(r => !r._isNew && !r._isDeleted && r._isDirty)
        .map(r => ({ id: r.id, ...toPayload(r) }));
      const deletes = rows.filter(r => !r._isNew && r._isDeleted).map(r => r.id);
      const res = await fetch(`/api/kit-booking/bom/${projectId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates, deletes, inserts }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || `Save failed (${res.status})`);
      triggerToast(`BOM saved: +${inserts.length} · Δ${updates.length} · −${deletes.length}`, 'SUCCESS');
      onSaved();
    } catch (err: any) {
      triggerToast(`Save failed: ${err.message}`, 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  function toPayload(r: BomRow) {
    return {
      stockCode: r.stockCode.trim(),
      quantity: r.quantity,
      designator: r.designator,
      description: r.description,
      comment: r.comment,
      footprint: r.footprint,
      libref: r.libref,
    };
  }

  return (
    <div
      className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md"
      onClick={() => { if (!saving) onClose(); }}
    >
      <div
        className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[960px] w-full max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <Pencil className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">
              {stockCode === null ? 'Add BOM line' : `Edit BOM · ${stockCode}`}
            </h4>
            <p className="text-[10px] text-outline mt-0.5">
              {stockCode === null
                ? 'Adds a new component to this project\'s BOM.'
                : 'Edits the raw source rows. Multiple entries (one per designator, or duplicates across legacy tables) are shown separately.'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => { if (!saving) onClose(); }}
            className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-lg py-md space-y-md">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-outline text-xs">
              <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading rows…
            </div>
          ) : (
            <>
              {rows.map((r) => {
                const isLegacy = LEGACY_TABLES.has(r._table);
                return (
                  <div
                    key={r.id}
                    className={`border rounded-lg p-md space-y-sm relative ${
                      r._isDeleted
                        ? 'border-error/40 bg-error/5 opacity-70'
                        : r._isNew
                          ? 'border-primary/40 bg-primary/5'
                          : r._isDirty
                            ? 'border-yellow-500/40 bg-yellow-500/5'
                            : 'border-outline-variant bg-surface-container-high/30'
                    }`}
                  >
                    <div className="flex items-center gap-sm text-[10px] font-mono uppercase tracking-wider text-outline">
                      <span>{r._isNew ? 'New row' : `source: ${r._table}`}</span>
                      {r._isDeleted && <span className="text-error font-bold">· pending delete</span>}
                      {r._isDirty && !r._isNew && !r._isDeleted && <span className="text-yellow-500 font-bold">· modified</span>}
                      <div className="flex-1" />
                      {r._isDeleted ? (
                        <button
                          type="button"
                          onClick={() => undoDelete(r.id)}
                          className="text-xs px-2 py-0.5 rounded border border-outline-variant hover:border-primary text-outline hover:text-primary"
                        >
                          Undo
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(r.id)}
                          className="p-1 rounded hover:bg-error/10 text-outline hover:text-error"
                          title={r._isNew ? 'Discard this row' : 'Delete this row'}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-12 gap-sm">
                      <Field label="Stock code" span={4} required>
                        <input
                          value={r.stockCode}
                          disabled={r._isDeleted}
                          onChange={(e) => patch(r.id, { stockCode: e.target.value })}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs font-mono focus:outline-none focus:border-primary disabled:opacity-50"
                          placeholder="e.g. CAP-019"
                        />
                      </Field>
                      <Field label="Qty per unit" span={2} required>
                        <input
                          type="number"
                          min={0}
                          value={r.quantity}
                          disabled={r._isDeleted}
                          onChange={(e) => patch(r.id, { quantity: Math.max(0, parseInt(e.target.value) || 0) })}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs font-mono text-right focus:outline-none focus:border-primary disabled:opacity-50"
                        />
                      </Field>
                      <Field label="Designator(s)" span={6}>
                        <input
                          value={r.designator}
                          disabled={r._isDeleted}
                          onChange={(e) => patch(r.id, { designator: e.target.value })}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs font-mono focus:outline-none focus:border-primary disabled:opacity-50"
                          placeholder="e.g. C1, C2, C17"
                        />
                      </Field>
                      <Field
                        label="Description"
                        span={12}
                        disabledHint={isLegacy ? 'from inventory (legacy source rows don\'t store their own)' : undefined}
                      >
                        <input
                          value={isLegacy ? (r.inventoryDescription || '') : r.description}
                          disabled={r._isDeleted || isLegacy}
                          onChange={(e) => patch(r.id, { description: e.target.value })}
                          placeholder={!isLegacy && r.inventoryDescription ? `Inventory: ${r.inventoryDescription}` : undefined}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs focus:outline-none focus:border-primary disabled:opacity-70"
                        />
                      </Field>
                      <Field
                        label="Comment"
                        span={6}
                        disabledHint={isLegacy ? 'from inventory' : undefined}
                      >
                        <input
                          value={isLegacy ? (r.inventoryComment || '') : r.comment}
                          disabled={r._isDeleted || isLegacy}
                          onChange={(e) => patch(r.id, { comment: e.target.value })}
                          placeholder={!isLegacy && r.inventoryComment ? `Inventory: ${r.inventoryComment}` : undefined}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs focus:outline-none focus:border-primary disabled:opacity-70"
                        />
                      </Field>
                      <Field
                        label="Footprint"
                        span={3}
                        disabledHint={isLegacy ? 'from inventory' : undefined}
                      >
                        <input
                          value={isLegacy ? (r.inventoryFootprint || '') : r.footprint}
                          disabled={r._isDeleted || isLegacy}
                          onChange={(e) => patch(r.id, { footprint: e.target.value })}
                          placeholder={!isLegacy && r.inventoryFootprint ? `Inventory: ${r.inventoryFootprint}` : undefined}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs font-mono focus:outline-none focus:border-primary disabled:opacity-70"
                        />
                      </Field>
                      <Field label="LibRef" span={3} disabledHint={isLegacy ? '—' : undefined}>
                        <input
                          value={r.libref}
                          disabled={r._isDeleted || isLegacy}
                          onChange={(e) => patch(r.id, { libref: e.target.value })}
                          className="w-full px-2 py-1.5 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs font-mono focus:outline-none focus:border-primary disabled:opacity-50"
                        />
                      </Field>
                    </div>

                    {confirmingDelete === r.id && !r._isDeleted && (
                      <div className="absolute inset-0 rounded-lg bg-background/95 backdrop-blur-sm border border-error/40 flex items-center justify-center gap-md p-md">
                        <AlertTriangle className="w-4 h-4 text-error shrink-0" />
                        <span className="text-xs text-on-surface">Delete this BOM row?</span>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          className="px-3 py-1 rounded text-xs font-bold border border-outline-variant hover:bg-surface-variant/40"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => markDeleted(r.id)}
                          className="px-3 py-1 rounded text-xs font-bold bg-error text-on-error hover:brightness-110"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}

              <button
                type="button"
                onClick={addRow}
                className="w-full py-2 rounded-lg border border-dashed border-outline-variant hover:border-primary text-outline hover:text-primary text-xs font-bold flex items-center justify-center gap-2"
              >
                <Plus className="w-3.5 h-3.5" />
                Add another row for this component
              </button>
            </>
          )}
        </div>

        <div className="px-lg py-md border-t border-outline-variant flex items-center justify-between gap-sm bg-surface-container-high/30">
          <div className="text-[10px] text-outline">
            Legacy source rows only carry stock code, quantity and designators — description/comment/footprint/libref land in the per-project table.
          </div>
          <div className="flex gap-sm">
            <button
              type="button"
              onClick={() => { if (!saving) onClose(); }}
              disabled={saving}
              className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 disabled:opacity-40"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={!anyChanges || anyBlockingErrors || saving || loading}
              className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
              title={
                anyBlockingErrors ? 'Every non-deleted row needs a stock code and a non-negative quantity.'
                : !anyChanges ? 'Nothing to save.'
                : undefined
              }
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// Tiny grid-cell helper — keeps the field markup terse in the main body.
function Field({ label, span, children, required, disabledHint }: { label: string; span: number; children: React.ReactNode; required?: boolean; disabledHint?: string }) {
  const spanClass = ({
    2: 'md:col-span-2',
    3: 'md:col-span-3',
    4: 'md:col-span-4',
    6: 'md:col-span-6',
    12: 'md:col-span-12',
  } as Record<number, string>)[span] || 'md:col-span-12';
  return (
    <label className={`col-span-2 ${spanClass} block`}>
      <span className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">
        {label}{required && <span className="text-error"> *</span>}
        {disabledHint && <span className="font-normal text-outline/70 lowercase italic ml-1">({disabledHint})</span>}
      </span>
      {children}
    </label>
  );
}
