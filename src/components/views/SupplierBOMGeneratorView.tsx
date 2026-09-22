// Supplier BOM Generator — port of the legacy Python tool
// (InventoryGrouping_SupplierBOMlistGeneration.py). Takes a
// pick-and-place / BOM CSV, resolves each part against the inventory's
// per-supplier PN columns (Mouser = sup_pn_1, DigiKey = sup_pn_2,
// LCSC = sup_pn_3, with the same equivalent-reel fallback the Python
// code used), and emits one CSV per supplier in each supplier's
// preferred upload shape.
//
// Row colouring, DNF skipping and the "check only rows with PN"
// bulk toggle all mirror the desktop tool so an operator moving from
// one to the other doesn't have to relearn the flow.

import React, { useMemo, useState } from 'react';
import { Upload, FileSpreadsheet, Download, CheckSquare, Square, ListFilter, AlertTriangle } from 'lucide-react';
import { fmtNumber } from '../../lib/formatMoney';

const SUPPLIERS = ['LCSC', 'DigiKey', 'Mouser'] as const;
type Supplier = typeof SUPPLIERS[number];

interface BomLine {
  part: string;
  qtyPerPcb: number;
  description: string;
  footprint: string;
  comment: string;
}

interface LookupResult {
  part: string;
  found: boolean;
  name: string;
  description: string;
  footprint: string;
  supplierPns: Record<Supplier, string>;
}

interface Row {
  part: string;
  description: string;
  footprint: string;
  supplierPn: string;
  qty: number;
  availableAt: string; // "NO PART" or "at LCSC, at DigiKey…"
  include: boolean;
}

// ─── CSV parsing (same shape KitBookingView uses) ─────────────────────────
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  const firstLine = text.split(/\r?\n/).find(l => l.trim()) || '';
  const counts: Record<string, number> = {
    ',': (firstLine.match(/,/g) || []).length,
    ';': (firstLine.match(/;/g) || []).length,
    '\t': (firstLine.match(/\t/g) || []).length,
  };
  let delim = ',';
  let best = -1;
  for (const [d, c] of Object.entries(counts)) if (c > best) { best = c; delim = d; }
  const rows: string[][] = [];
  let cur: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cell += ch;
    } else {
      if (ch === '"') inQ = true;
      else if (ch === delim) { cur.push(cell); cell = ''; }
      else if (ch === '\n') { cur.push(cell); rows.push(cur); cur = []; cell = ''; }
      else if (ch !== '\r') cell += ch;
    }
  }
  if (cell !== '' || cur.length) { cur.push(cell); rows.push(cur); }
  const nonEmpty = rows.filter(r => r.some(c => c.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const [headerRow, ...dataRows] = nonEmpty;
  return { headers: headerRow.map(h => h.trim()), rows: dataRows };
}

const DNF_RE = /\bDNF\b/i;

function parseBomFile(text: string): BomLine[] {
  const { headers, rows } = parseCsv(text);
  if (!headers.length) throw new Error('CSV appears empty.');
  const lc = headers.map(h => h.toLowerCase());
  const idx = (candidates: string[]) => {
    for (const c of candidates) {
      const i = lc.indexOf(c);
      if (i >= 0) return i;
    }
    return -1;
  };
  const partIdx = idx(['stock_code', 'part number', 'partno', 'part_number', 'component', 'part']);
  if (partIdx < 0) throw new Error(`No part-number column found. Headers: ${headers.join(', ')}`);
  const qtyIdx = idx(['qty', 'quantity', 'qty per pcb', 'qty_per_pcb']);
  if (qtyIdx < 0) throw new Error(`No quantity column found. Headers: ${headers.join(', ')}`);
  const commentIdx = idx(['comment']);
  const descIdx = idx(['description']);
  const fpIdx = idx(['footprint']);

  const merged = new Map<string, BomLine>();
  for (const row of rows) {
    const part = (row[partIdx] || '').trim();
    if (!part || part.toLowerCase() === 'nan') continue;
    if (DNF_RE.test(part)) continue;
    const rawQty = (row[qtyIdx] || '').trim();
    const qty = Math.floor(Number(rawQty) || 0);
    if (qty <= 0) continue;

    const existing = merged.get(part);
    if (existing) {
      existing.qtyPerPcb += qty;
    } else {
      merged.set(part, {
        part,
        qtyPerPcb: qty,
        description: descIdx >= 0 ? (row[descIdx] || '').trim() : '',
        footprint: fpIdx >= 0 ? (row[fpIdx] || '').trim() : '',
        comment: commentIdx >= 0 ? (row[commentIdx] || '').trim() : '',
      });
    }
  }
  return Array.from(merged.values());
}

function availabilityNote(pns: Record<Supplier, string>): string {
  const where = SUPPLIERS.filter(s => pns[s]);
  if (where.length === 0) return 'NO PART';
  return 'at ' + where.join(', at ');
}

// ─── CSV writers per supplier (same formats as the Python tool) ───────────

function toMouserCsv(rows: Row[]): string {
  return rows.map(r => `${r.supplierPn}|${r.qty}`).join('\n') + '\n';
}
function toDigikeyCsv(rows: Row[]): string {
  const head = 'Quantity,Part Number\n';
  const body = rows.map(r => `${r.qty},"${r.supplierPn.replace(/"/g, '""')}"`).join('\n');
  return head + body + '\n';
}
function toLcscCsv(rows: Row[]): string {
  const head = 'Comment,Designator,Footprint,LCSC Part #,Quantity\n';
  const esc = (s: string) => (s || '').replace(/,/g, ' ');
  const body = rows.map(r => `"${esc(r.description)}","","${esc(r.footprint)}","${r.supplierPn}",${r.qty}`).join('\n');
  return head + body + '\n';
}

function downloadCsv(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

interface Props {
  triggerToast: (msg: string, type?: 'SUCCESS' | 'ERROR' | 'INFO') => void;
}

export const SupplierBOMGeneratorView: React.FC<Props> = ({ triggerToast }) => {
  const [fileName, setFileName] = useState<string>('');
  const [bomLines, setBomLines] = useState<BomLine[]>([]);
  const [boardQty, setBoardQty] = useState(1);
  const [lookup, setLookup] = useState<Map<string, LookupResult>>(new Map());
  const [activeTab, setActiveTab] = useState<Supplier>('LCSC');
  const [includeState, setIncludeState] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);

  const includeKey = (supplier: Supplier, part: string) => `${supplier}::${part}`;

  const runLookup = async (parts: string[]) => {
    if (!parts.length) return new Map<string, LookupResult>();
    const res = await fetch('/api/supplier-bom/lookup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Lookup failed');
    const data: LookupResult[] = await res.json();
    const map = new Map<string, LookupResult>();
    for (const r of data) map.set(r.part, r);
    return map;
  };

  const onFile = async (file: File) => {
    setLoading(true);
    try {
      const text = await file.text();
      const parsed = parseBomFile(text);
      if (!parsed.length) throw new Error('No usable lines after DNF-skip / qty filtering.');
      const map = await runLookup(parsed.map(l => l.part));
      setFileName(file.name);
      setBomLines(parsed);
      setLookup(map);
      // Fresh include state — new BOM, everything ON by default
      setIncludeState({});
      triggerToast(`Loaded ${parsed.length} unique parts from ${file.name}.`);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to parse BOM', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const rowsBySupplier = useMemo<Record<Supplier, Row[]>>(() => {
    const out: Record<Supplier, Row[]> = { LCSC: [], DigiKey: [], Mouser: [] };
    for (const s of SUPPLIERS) {
      out[s] = bomLines.map(b => {
        const l = lookup.get(b.part);
        const pns: Record<Supplier, string> = l?.supplierPns || { LCSC: '', DigiKey: '', Mouser: '' };
        const key = includeKey(s, b.part);
        const include = includeState[key] ?? true;
        return {
          part: b.part,
          description: l?.description || b.description || b.comment,
          footprint: l?.footprint || b.footprint,
          supplierPn: pns[s] || '',
          qty: b.qtyPerPcb * boardQty,
          availableAt: availabilityNote(pns),
          include,
        };
      });
    }
    return out;
  }, [bomLines, lookup, boardQty, includeState]);

  const setAll = (supplier: Supplier, value: boolean) => {
    setIncludeState(prev => {
      const next = { ...prev };
      for (const b of bomLines) next[includeKey(supplier, b.part)] = value;
      return next;
    });
  };

  const checkOnlyReady = (supplier: Supplier) => {
    setIncludeState(prev => {
      const next = { ...prev };
      for (const r of rowsBySupplier[supplier]) next[includeKey(supplier, r.part)] = !!r.supplierPn;
      return next;
    });
  };

  const toggleOne = (supplier: Supplier, part: string, v: boolean) => {
    setIncludeState(prev => ({ ...prev, [includeKey(supplier, part)]: v }));
  };

  const doExport = (supplier: Supplier) => {
    const all = rowsBySupplier[supplier];
    const writable = all.filter(r => r.include && r.supplierPn);
    const skippedNoPn = all.filter(r => r.include && !r.supplierPn).length;
    const skippedUnchecked = all.filter(r => !r.include).length;
    if (!writable.length) {
      triggerToast(`No includable rows with a ${supplier} PN. Nothing written.`, 'ERROR');
      return;
    }
    let csv = '';
    let name = '';
    if (supplier === 'Mouser') { csv = toMouserCsv(writable); name = 'mouser_bom.csv'; }
    else if (supplier === 'DigiKey') { csv = toDigikeyCsv(writable); name = 'digikey_bom.csv'; }
    else { csv = toLcscCsv(writable); name = 'lcsc_bom.csv'; }
    downloadCsv(name, csv);
    const bits = [`${writable.length} rows written`];
    if (skippedNoPn) bits.push(`${skippedNoPn} missing ${supplier} PN`);
    if (skippedUnchecked) bits.push(`${skippedUnchecked} unticked`);
    triggerToast(`${supplier} BOM exported — ${bits.join(' · ')}.`);
  };

  const activeRows = rowsBySupplier[activeTab];
  const readyCount = activeRows.filter(r => r.supplierPn).length;
  const noPartCount = activeRows.filter(r => r.availableAt === 'NO PART').length;

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      <div>
        <h3 className="font-headline-sm text-2xl font-black text-on-surface tracking-tighter leading-none mb-1">Supplier BOM Generator</h3>
        <p className="text-on-surface-variant font-body-sm/80">Upload a pick-and-place BOM, resolve each part against the three inventory supplier columns, and export the shape each supplier's upload form expects.</p>
      </div>

      {/* Source panel */}
      <div className="bg-surface-container rounded-xl border border-outline-variant p-lg space-y-md">
        <div className="flex items-center gap-md flex-wrap">
          <label className="inline-flex items-center gap-sm px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold cursor-pointer hover:opacity-90 transition-all">
            <Upload className="w-3.5 h-3.5" />
            {loading ? 'Loading…' : 'Load BOM CSV'}
            <input
              type="file"
              accept=".csv,.txt,.tsv"
              className="hidden"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.currentTarget.value = ''; }}
              disabled={loading}
            />
          </label>
          <div className="flex items-center gap-sm">
            <span className="text-xs font-bold text-on-surface-variant">Board Qty</span>
            <input
              type="number"
              min={1}
              max={100000}
              value={boardQty}
              onChange={(e) => setBoardQty(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
              className="w-24 rounded-lg border border-outline-variant bg-surface-container-low px-2 py-1 text-sm text-on-surface focus:outline-none focus:border-primary text-right font-mono"
            />
          </div>
          <div className="flex-1 min-w-0">
            {fileName ? (
              <div className="flex items-center gap-sm text-xs">
                <FileSpreadsheet className="w-3.5 h-3.5 text-primary shrink-0" />
                <span className="font-mono text-primary truncate">{fileName}</span>
                <span className="text-outline">·</span>
                <span className="text-on-surface-variant">{fmtNumber(bomLines.length)} unique parts after DNF-skip / merge</span>
              </div>
            ) : (
              <span className="text-xs text-outline italic">No BOM loaded. Accepts .csv with a part-number column and a qty column (DNF rows are auto-skipped).</span>
            )}
          </div>
        </div>
      </div>

      {/* Per-supplier tabs */}
      {bomLines.length > 0 && (
        <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
          <div className="flex items-center gap-1 border-b border-outline-variant/40 bg-surface-container-high/30 p-sm">
            {SUPPLIERS.map(s => {
              const active = s === activeTab;
              return (
                <button
                  key={s}
                  onClick={() => setActiveTab(s)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${active ? 'bg-primary text-white shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                >
                  {s}
                </button>
              );
            })}
            <div className="flex-1" />
            <div className="text-[10px] text-on-surface-variant">
              <span className="font-mono font-bold text-primary">{fmtNumber(readyCount)}</span> of {fmtNumber(activeRows.length)} rows have a {activeTab} PN
              {noPartCount > 0 && <span className="text-error"> · {fmtNumber(noPartCount)} unlisted anywhere</span>}
            </div>
          </div>

          <div className="p-lg space-y-md">
            <p className="text-xs text-on-surface-variant">
              Red rows have no <span className="font-bold">{activeTab}</span> PN.
              <span className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-error/20 text-error text-[10px] font-bold">NO PART</span>
              means the part isn't listed at any of the three suppliers — the inventory row is missing all three sup_pn columns.
            </p>

            <div className="flex items-center gap-sm flex-wrap">
              <button onClick={() => setAll(activeTab, true)} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-container-high border border-outline-variant text-xs font-bold hover:bg-surface-container-highest transition-all">
                <CheckSquare className="w-3.5 h-3.5" /> Check all
              </button>
              <button onClick={() => setAll(activeTab, false)} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-container-high border border-outline-variant text-xs font-bold hover:bg-surface-container-highest transition-all">
                <Square className="w-3.5 h-3.5" /> Uncheck all
              </button>
              <button onClick={() => checkOnlyReady(activeTab)} className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface-container-high border border-outline-variant text-xs font-bold hover:bg-surface-container-highest transition-all">
                <ListFilter className="w-3.5 h-3.5" /> Check only rows with PN
              </button>
              <div className="flex-1" />
              <button
                onClick={() => doExport(activeTab)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-xs font-bold hover:opacity-90 transition-all"
              >
                <Download className="w-3.5 h-3.5" /> Export {activeTab} CSV
              </button>
            </div>

            <div className="overflow-x-auto rounded-lg border border-outline-variant/40">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-surface-container-high/50 text-outline text-[10px] uppercase font-bold">
                    <th className="py-2 px-3">Part</th>
                    <th className="py-2 px-3">Description</th>
                    <th className="py-2 px-3">Footprint</th>
                    <th className="py-2 px-3">{activeTab} PN</th>
                    <th className="py-2 px-3 text-right">Qty</th>
                    <th className="py-2 px-3">Available at</th>
                    <th className="py-2 px-3 text-center w-16">Include?</th>
                  </tr>
                </thead>
                <tbody>
                  {activeRows.map((r) => {
                    const noPart = r.availableAt === 'NO PART';
                    const missing = !r.supplierPn;
                    const bg = noPart ? 'bg-error/15' : missing ? 'bg-tertiary/10' : '';
                    return (
                      <tr key={r.part} className={`border-t border-outline-variant/20 ${bg}`}>
                        <td className="py-2 px-3 font-mono text-primary font-bold whitespace-nowrap">{r.part}</td>
                        <td className="py-2 px-3">{r.description || <span className="text-outline italic">—</span>}</td>
                        <td className="py-2 px-3 font-mono text-[11px]">{r.footprint || <span className="text-outline">—</span>}</td>
                        <td className="py-2 px-3 font-mono">
                          {r.supplierPn ? (
                            <span className="text-on-surface">{r.supplierPn}</span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-error font-bold"><AlertTriangle className="w-3 h-3" /> MISSING</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right font-mono">{fmtNumber(r.qty)}</td>
                        <td className="py-2 px-3">
                          {noPart ? (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-error/20 text-error text-[10px] font-bold">NO PART</span>
                          ) : (
                            <span className="text-on-surface-variant text-[11px]">{r.availableAt}</span>
                          )}
                        </td>
                        <td className="py-2 px-3 text-center">
                          <input
                            type="checkbox"
                            checked={r.include}
                            onChange={(e) => toggleOne(activeTab, r.part, e.target.checked)}
                            className="w-3.5 h-3.5 accent-primary cursor-pointer"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SupplierBOMGeneratorView;
