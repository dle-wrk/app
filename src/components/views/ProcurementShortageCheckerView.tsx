// Procurement Shortage Checker — takes N kit-booking shortage CSV
// exports, appends them without overwriting, dedupes by Part number,
// and shows a single consolidated table the buyer can save as a named
// procurement project and download as CSV (with MFN part numbers
// appended). Aggregation rule per spec:
//
//   - Shortage: SUM across duplicate part numbers
//   - Qty per PCB, Needed, On Hand, Reserved: MAX
//   - Designator: union of unique tokens
//   - Description / Alternates: first non-empty value seen
//
// The MFN column is added ONLY at CSV-export time (spec item 10) and
// is looked up from the inventory table via /api/inventory/mfn.

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Upload,
  Save as SaveIcon,
  Download,
  FolderOpen,
  Trash2,
  Package,
  AlertCircle,
  Loader2,
  X,
  Search,
} from 'lucide-react';
import { useEscapeKey } from '../../lib/useEscapeKey';
import { fmtNumber } from '../../lib/formatMoney';

interface MergedRow {
  part: string;
  description: string;
  designator: string;
  qtyPerPcb: number;
  needed: number;
  onHand: number;
  shortage: number;
  alternatesUsed: string;
  reservedElsewhere: number;
  sourceFiles: string[];
}

interface SavedProject {
  id: number;
  name: string;
  notes: string;
  rowCount: number;
  totalShortage: number;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

interface Props {
  triggerToast: (msg: string, type?: string) => void;
}

// -----------------------------------------------------------------------
// Minimal CSV parser — RFC 4180-flavoured: comma-separated, quoted
// fields, doubled quotes for literal quotes, CR/LF/CRLF row endings.
// The kit-booking export is well-defined so we don't need PapaParse's
// dependency for this one shape.
// -----------------------------------------------------------------------
function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cur = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  // Strip UTF-8 BOM if present so the first header key doesn't come
  // out as "﻿Part".
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') {
      row.push(cur); rows.push(row); row = []; cur = ''; i++; continue;
    }
    cur += ch; i++;
  }
  if (cur.length || row.length) { row.push(cur); rows.push(row); }
  if (rows.length === 0) return [];
  const headers = rows[0].map(h => h.trim());
  const out: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const values = rows[r];
    if (values.length === 1 && values[0] === '') continue; // blank line
    const obj: Record<string, string> = {};
    for (let c = 0; c < headers.length; c++) {
      obj[headers[c]] = (values[c] ?? '').trim();
    }
    out.push(obj);
  }
  return out;
}

const toInt = (v: any): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? Math.round(n) : 0;
};

// Aggregation implements spec items 4-6. Key by uppercase part number
// so "cap-019" and "CAP-019" collapse; final display keeps the first
// casing seen.
function aggregate(rows: Array<Record<string, string> & { __src?: string }>): MergedRow[] {
  const groups = new Map<string, MergedRow>();
  for (const r of rows) {
    const part = String(r['Part'] || '').trim();
    if (!part) continue;
    const key = part.toUpperCase();
    const qtyPerPcb = toInt(r['Qty per PCB']);
    const needed = toInt(r['Needed']);
    const onHand = toInt(r['On Hand']);
    const shortage = toInt(r['Shortage']);
    const reserved = toInt(r['Reserved elsewhere']);
    const description = String(r['Description'] || '').trim();
    const designator = String(r['Designator'] || '').trim();
    const alternates = String(r['Alternates used'] || '').trim();
    const src = r.__src || '';

    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        part,
        description,
        designator,
        qtyPerPcb,
        needed,
        onHand,
        shortage,
        alternatesUsed: alternates,
        reservedElsewhere: reserved,
        sourceFiles: src ? [src] : [],
      });
    } else {
      // Shortage: SUM (spec item 5)
      existing.shortage += shortage;
      // Everything else numeric: MAX (spec item 6)
      existing.qtyPerPcb = Math.max(existing.qtyPerPcb, qtyPerPcb);
      existing.needed = Math.max(existing.needed, needed);
      existing.onHand = Math.max(existing.onHand, onHand);
      existing.reservedElsewhere = Math.max(existing.reservedElsewhere, reserved);
      // Union designators, keep sort stable
      const combined = new Set<string>();
      for (const tok of existing.designator.split(',')) { const t = tok.trim(); if (t) combined.add(t); }
      for (const tok of designator.split(',')) { const t = tok.trim(); if (t) combined.add(t); }
      existing.designator = Array.from(combined).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(', ');
      // Description: keep first non-empty, but upgrade if we had blank
      if (!existing.description && description) existing.description = description;
      if (!existing.alternatesUsed && alternates) existing.alternatesUsed = alternates;
      if (src && !existing.sourceFiles.includes(src)) existing.sourceFiles.push(src);
    }
  }
  // Natural sort by part number (RES-002 before RES-010)
  return Array.from(groups.values()).sort((a, b) =>
    a.part.localeCompare(b.part, undefined, { numeric: true, sensitivity: 'base' })
  );
}

export default function ProcurementShortageCheckerView({ triggerToast }: Props) {
  const [loadedFiles, setLoadedFiles] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<Array<Record<string, string> & { __src?: string }>>([]);
  const [projectName, setProjectName] = useState<string>('');
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [showSave, setShowSave] = useState(false);
  const [showBrowser, setShowBrowser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEscapeKey(() => setShowSave(false), showSave);
  useEscapeKey(() => setShowBrowser(false), showBrowser);

  const mergedRows = useMemo(() => aggregate(rawRows), [rawRows]);
  const totalShortage = useMemo(() => mergedRows.reduce((s, r) => s + r.shortage, 0), [mergedRows]);

  const loadSaved = useCallback(async () => {
    try {
      const res = await fetch('/api/procurement-projects');
      if (!res.ok) return;
      const data = await res.json();
      setSavedProjects(Array.isArray(data) ? data : []);
    } catch { /* no-op */ }
  }, []);
  useEffect(() => { loadSaved(); }, [loadSaved]);

  const processFiles = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    const newlyParsed: typeof rawRows = [];
    const newNames: string[] = [];
    for (const f of list) {
      if (!/\.csv$/i.test(f.name)) {
        triggerToast(`Skipping ${f.name} (not a .csv).`, 'ERROR');
        continue;
      }
      try {
        const text = await f.text();
        const parsed = parseCsv(text);
        const stamped = parsed
          .filter(r => (r['Part'] || '').trim() !== '')
          .map(r => ({ ...r, __src: f.name }));
        newlyParsed.push(...stamped);
        newNames.push(f.name);
      } catch (err: any) {
        triggerToast(`Failed to read ${f.name}: ${err.message || err}`, 'ERROR');
      }
    }
    if (newlyParsed.length === 0) return;
    // Append, not replace — spec item 3.
    setRawRows(prev => [...prev, ...newlyParsed]);
    setLoadedFiles(prev => [...prev, ...newNames]);
    triggerToast(`Added ${newNames.length} file${newNames.length === 1 ? '' : 's'} (${newlyParsed.length} rows).`, 'SUCCESS');
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files);
  };

  const handleClear = () => {
    if (rawRows.length === 0) return;
    setRawRows([]);
    setLoadedFiles([]);
    triggerToast('Cleared all loaded files.', 'INFO');
  };

  const handleSave = async (name: string, notes: string) => {
    if (!name.trim()) { triggerToast('Project name is required.', 'ERROR'); return; }
    if (mergedRows.length === 0) { triggerToast('Nothing to save — upload at least one CSV.', 'ERROR'); return; }
    setBusy(true);
    try {
      const res = await fetch('/api/procurement-projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          notes,
          rows: mergedRows,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      triggerToast(body.replaced ? `Overwrote "${name.trim()}".` : `Saved "${name.trim()}".`, 'SUCCESS');
      setProjectName(name.trim());
      setShowSave(false);
      loadSaved();
    } catch (err: any) {
      triggerToast(`Save failed: ${err.message}`, 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleLoad = async (id: number) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/procurement-projects/${id}`);
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      // Rehydrate as if this project were freshly parsed from a single
      // synthetic source so the merged table matches what was saved.
      const synth: typeof rawRows = (data.rows || []).map((r: MergedRow) => ({
        'Part': r.part,
        'Description': r.description,
        'Designator': r.designator,
        'Qty per PCB': String(r.qtyPerPcb),
        'Needed': String(r.needed),
        'On Hand': String(r.onHand),
        'Shortage': String(r.shortage),
        'Alternates used': r.alternatesUsed || '',
        'Reserved elsewhere': String(r.reservedElsewhere),
        __src: `[saved:${data.name}]`,
      }));
      setRawRows(synth);
      setLoadedFiles([`[saved:${data.name}]`]);
      setProjectName(data.name);
      setShowBrowser(false);
      triggerToast(`Loaded "${data.name}" (${synth.length} rows).`, 'SUCCESS');
    } catch (err: any) {
      triggerToast(`Load failed: ${err.message}`, 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number, name: string) => {
    if (!window.confirm(`Delete procurement project "${name}"?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/procurement-projects/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed (${res.status})`);
      triggerToast(`Deleted "${name}".`, 'SUCCESS');
      loadSaved();
    } catch (err: any) {
      triggerToast(`Delete failed: ${err.message}`, 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const handleDownloadCsv = async (filename: string) => {
    if (mergedRows.length === 0) { triggerToast('Nothing to export.', 'ERROR'); return; }
    setBusy(true);
    try {
      // MFN lookup — one batched call keyed on the deduped part list.
      // Missing SKUs (test/DNF placeholders that never made it into
      // inventory) come back empty and land as blank cells rather than
      // errors.
      const parts = Array.from(new Set(mergedRows.map(r => r.part)));
      const mfnRes = await fetch(`/api/inventory/mfn?parts=${encodeURIComponent(parts.join(','))}`);
      const mfnMap: Record<string, string> = mfnRes.ok ? await mfnRes.json() : {};

      const esc = (v: any): string => {
        const s = String(v ?? '');
        return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const header = ['Part', 'Description', 'Designator', 'Qty per PCB', 'Needed', 'On Hand', 'Shortage', 'Alternates used', 'Reserved elsewhere', 'MFN Part Number'];
      const lines = [header.join(',')];
      for (const r of mergedRows) {
        lines.push([
          r.part,
          r.description,
          r.designator,
          r.qtyPerPcb,
          r.needed,
          r.onHand,
          r.shortage,
          r.alternatesUsed,
          r.reservedElsewhere,
          mfnMap[r.part] || '',
        ].map(esc).join(','));
      }
      const csv = '﻿' + lines.join('\r\n');
      const safe = filename.trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'procurement_shortages';
      const finalName = /\.csv$/i.test(safe) ? safe : `${safe}.csv`;
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = finalName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      triggerToast(`Downloaded ${finalName} (${mergedRows.length} rows).`, 'SUCCESS');
    } catch (err: any) {
      triggerToast(`Download failed: ${err.message}`, 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <Package className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">Procurement</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Procurement Shortage Checker</h3>
          <p className="text-on-surface-variant text-xs max-w-[720px]">
            Upload one or more shortage CSVs exported from P&amp;P Kit Booking. Duplicates by Part are merged — Shortage summed, Qty per PCB / Needed / On Hand / Reserved take the maximum. Save the result as a procurement project or download it with MFN part numbers appended.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-sm">
          <button
            onClick={() => { loadSaved(); setShowBrowser(true); }}
            className="h-9 px-md rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-surface-container-high border border-outline-variant text-on-surface hover:border-primary/60 active:scale-95"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            Load
          </button>
          <button
            onClick={() => setShowSave(true)}
            disabled={mergedRows.length === 0}
            className="h-9 px-md rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-surface-container-high border border-outline-variant text-on-surface hover:border-primary/60 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <SaveIcon className="w-3.5 h-3.5" />
            Save Project
          </button>
          <button
            onClick={() => handleDownloadCsv(projectName || 'procurement_shortages')}
            disabled={mergedRows.length === 0 || busy}
            className="h-9 px-md rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-3.5 h-3.5" />
            Download CSV
          </button>
        </div>
      </div>

      {/* Upload zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`border-2 border-dashed rounded-xl px-lg py-md flex flex-wrap items-center justify-between gap-md transition-colors ${
          dragOver ? 'border-primary bg-primary/5' : 'border-outline-variant bg-surface-container-low'
        }`}
      >
        <div className="flex items-center gap-md flex-wrap">
          <label className="cursor-pointer bg-primary text-on-primary hover:brightness-110 active:scale-95 px-md py-2 rounded-lg flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider">
            <Upload className="w-3.5 h-3.5" />
            Choose CSV files
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              multiple
              onChange={handleFileInput}
              className="hidden"
            />
          </label>
          <div className="text-[11px] text-outline">
            {loadedFiles.length === 0
              ? 'or drag & drop here — multiple files append together'
              : `${loadedFiles.length} file${loadedFiles.length === 1 ? '' : 's'} loaded · ${rawRows.length} raw row${rawRows.length === 1 ? '' : 's'}`}
          </div>
        </div>
        {loadedFiles.length > 0 && (
          <button
            onClick={handleClear}
            className="h-8 px-3 rounded-lg text-[11px] font-bold uppercase tracking-wider border border-outline-variant text-outline hover:text-error hover:border-error/60 flex items-center gap-1"
          >
            <Trash2 className="w-3 h-3" />
            Clear
          </button>
        )}
      </div>

      {/* Loaded-file chips */}
      {loadedFiles.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {loadedFiles.map((name, i) => (
            <span key={`${name}-${i}`} className="inline-flex items-center gap-1 px-2 py-1 rounded bg-surface-container-high border border-outline-variant text-[10px] font-mono text-on-surface-variant">
              {name}
            </span>
          ))}
        </div>
      )}

      {/* Results table */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-wrap justify-between items-center gap-sm text-xs">
          <span className="font-mono uppercase tracking-tight font-black text-on-surface-variant">
            Consolidated Shortages
          </span>
          {mergedRows.length > 0 && (
            <span className="text-[10px] font-mono text-outline">
              {mergedRows.length} unique part{mergedRows.length === 1 ? '' : 's'} · total shortage {fmtNumber(totalShortage)}
            </span>
          )}
        </div>
        <div className="overflow-x-auto max-h-[650px] overflow-y-auto">
          <table className="w-full text-left border-collapse min-w-[1100px]">
            <thead>
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant sticky top-0 z-10">
                <th className="px-md py-2">Part</th>
                <th className="px-md py-2">Description</th>
                <th className="px-md py-2">Designator</th>
                <th className="px-md py-2 text-right">Qty per PCB</th>
                <th className="px-md py-2 text-right">Needed</th>
                <th className="px-md py-2 text-right">On Hand</th>
                <th className="px-md py-2 text-right">Shortage</th>
                <th className="px-md py-2 text-right">Reserved</th>
                <th className="px-md py-2">Sources</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {mergedRows.map(r => (
                <tr key={r.part} className="hover:bg-surface-variant/20 transition-all">
                  <td className="px-md py-2 font-mono font-bold text-primary">{r.part}</td>
                  <td className="px-md py-2 max-w-[340px]">
                    <div className="truncate" title={r.description}>{r.description || <span className="italic text-outline">—</span>}</div>
                  </td>
                  <td className="px-md py-2 max-w-[220px]">
                    <div className="truncate text-outline text-[11px]" title={r.designator}>{r.designator || '—'}</div>
                  </td>
                  <td className="px-md py-2 text-right font-mono">{fmtNumber(r.qtyPerPcb)}</td>
                  <td className="px-md py-2 text-right font-mono">{fmtNumber(r.needed)}</td>
                  <td className="px-md py-2 text-right font-mono">{fmtNumber(r.onHand)}</td>
                  <td className="px-md py-2 text-right">
                    <span className="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold font-mono bg-red-500/15 text-red-400 border border-red-500/25">
                      {fmtNumber(r.shortage)}
                    </span>
                  </td>
                  <td className="px-md py-2 text-right font-mono text-outline">{r.reservedElsewhere > 0 ? fmtNumber(r.reservedElsewhere) : ''}</td>
                  <td className="px-md py-2 text-[10px] text-outline font-mono max-w-[160px]">
                    <div className="truncate" title={r.sourceFiles.join(', ')}>
                      {r.sourceFiles.length}×
                    </div>
                  </td>
                </tr>
              ))}
              {mergedRows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-lg py-12 text-center text-outline italic">
                    <AlertCircle className="w-4 h-4 inline-block mr-1.5 -mt-0.5" />
                    No data yet — upload one or more shortage CSVs above to see the consolidated table.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showSave && (
        <SaveProjectDialog
          initialName={projectName || `Procurement_${new Date().toISOString().slice(0, 10)}`}
          busy={busy}
          onCancel={() => setShowSave(false)}
          onSave={handleSave}
        />
      )}
      {showBrowser && (
        <LoadBrowserDialog
          projects={savedProjects}
          busy={busy}
          onLoad={handleLoad}
          onDelete={handleDelete}
          onClose={() => setShowBrowser(false)}
        />
      )}
    </div>
  );
}

// -----------------------------------------------------------------------
// Save dialog — name is used as both the DB key (upsert-on-name) and
// the default CSV filename. Notes are stored on the row for future use.
// -----------------------------------------------------------------------
function SaveProjectDialog({ initialName, busy, onCancel, onSave }: {
  initialName: string;
  busy: boolean;
  onCancel: () => void;
  onSave: (name: string, notes: string) => void;
}) {
  const [name, setName] = useState(initialName);
  const [notes, setNotes] = useState('');
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onCancel}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[480px] w-full" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <SaveIcon className="w-4 h-4 text-primary" />
          <div>
            <h4 className="font-bold text-sm text-on-surface">Save procurement project</h4>
            <p className="text-[10px] text-outline mt-0.5">Reusing an existing name overwrites that project.</p>
          </div>
        </div>
        <div className="px-lg py-md space-y-md">
          <div>
            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Project name *</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm font-mono focus:outline-none focus:border-primary"
            />
          </div>
          <div>
            <label className="block text-[10px] font-bold text-outline uppercase tracking-wider mb-1">Notes</label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-xs focus:outline-none focus:border-primary resize-none"
              placeholder="Optional"
            />
          </div>
        </div>
        <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
          <button onClick={onCancel} disabled={busy} className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 disabled:opacity-40">Cancel</button>
          <button
            onClick={() => onSave(name, notes)}
            disabled={busy || !name.trim()}
            className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40 flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <SaveIcon className="w-3.5 h-3.5" />}
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------
// Load browser — sorted by updatedAt descending (most recent first).
// -----------------------------------------------------------------------
function LoadBrowserDialog({ projects, busy, onLoad, onDelete, onClose }: {
  projects: SavedProject[];
  busy: boolean;
  onLoad: (id: number) => void;
  onDelete: (id: number, name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState('');
  const filtered = projects.filter(p => !q.trim() || p.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="fixed inset-0 z-[200] bg-background/85 backdrop-blur-sm flex items-center justify-center p-md" onClick={onClose}>
      <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[720px] w-full max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm">
          <FolderOpen className="w-4 h-4 text-primary" />
          <div className="flex-1">
            <h4 className="font-bold text-sm text-on-surface">Load procurement project</h4>
            <p className="text-[10px] text-outline mt-0.5">Saved consolidated shortages you can pick back up.</p>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-surface-variant/40 text-outline hover:text-on-surface">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-lg py-sm border-b border-outline-variant">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-outline pointer-events-none" />
            <input
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name…"
              className="w-full bg-surface-container-high border border-outline-variant rounded pl-7 pr-2 py-1.5 text-xs text-on-surface outline-none focus:border-primary"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="p-lg text-center text-xs text-outline italic">
              {projects.length === 0 ? 'No procurement projects saved yet.' : `No matches for "${q}".`}
            </div>
          ) : (
            <div className="divide-y divide-outline-variant/30">
              {filtered.map(p => (
                <div key={p.id} className="px-lg py-sm flex items-start gap-sm hover:bg-surface-variant/20">
                  <div className="flex-1 min-w-0">
                    <div className="font-mono text-xs font-bold text-primary truncate">{p.name}</div>
                    <div className="text-[10px] text-outline font-mono mt-0.5">
                      {p.rowCount} part{p.rowCount === 1 ? '' : 's'} · total shortage {fmtNumber(p.totalShortage)} · updated {new Date(p.updatedAt).toLocaleString()}
                    </div>
                    {p.notes && <div className="text-[10px] text-on-surface-variant mt-1 truncate italic">{p.notes}</div>}
                  </div>
                  <button
                    onClick={() => onLoad(p.id)}
                    disabled={busy}
                    className="px-3 py-1 rounded text-[10px] font-bold uppercase tracking-wider bg-primary text-on-primary hover:brightness-110 active:scale-95 disabled:opacity-40"
                  >
                    Load
                  </button>
                  <button
                    onClick={() => onDelete(p.id, p.name)}
                    disabled={busy}
                    className="p-1.5 rounded text-outline hover:text-error hover:bg-error/10 disabled:opacity-40"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
