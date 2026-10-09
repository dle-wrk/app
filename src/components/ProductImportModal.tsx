// Production Costs > Import: pick a spreadsheet or CSV, see what it would add
// and change, then import. Reading the file and the rules: ../lib/productImport;
// the server works the plan out again and applies it in one transaction.

import React, { useState } from 'react';
import { FileUp, Loader2 } from 'lucide-react';
import { parseDelimited } from '../lib/inventoryImport';
import {
  FIELD_LABELS, readProductSheets, readProductTable,
  type ProductChange, type ProductFields, type ProductTable,
} from '../lib/productImport';
import { Modal, PrimaryButton, SecondaryButton, fmtMoney } from './bookkeeping/shared';

interface Plan {
  added: number;
  updated: number;
  unchanged: number;
  changes: ProductChange[];
}

interface Props {
  onClose: () => void;
  onImported: (message: string) => void;
  onExport: () => void;
  triggerToast: (msg: string, type?: any) => void;
}

async function readFile(file: File): Promise<ProductTable> {
  const name = file.name.toLowerCase();
  let table: ProductTable | { error: string };
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
    const XLSX = await import('xlsx');
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', cellDates: true });
    table = readProductSheets(wb.SheetNames.map((sheetName) => ({
      name: sheetName,
      rows: XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: '', blankrows: false }),
    })));
  } else {
    table = readProductTable(parseDelimited(await file.text()));
  }
  if ('error' in table) throw new Error(table.error);
  if (table.rows.length === 0) throw new Error('it has no products in it.');
  return table;
}

async function send(rows: ProductTable['rows'], apply: boolean): Promise<Plan> {
  const res = await fetch('/api/production-products/import', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows, apply }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `the server said ${res.status}`);
  return data;
}

const show = (field: keyof ProductFields, v: unknown) => {
  if (v === null || v === undefined || v === '') return <span className="text-outline italic">empty</span>;
  return field === 'productionCost' || field === 'sellingPrice' ? fmtMoney(Number(v)) : String(v);
};

export const ProductImportModal: React.FC<Props> = ({ onClose, onImported, onExport, triggerToast }) => {
  const [file, setFile] = useState<string | null>(null);
  const [table, setTable] = useState<ProductTable | null>(null);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'reading' | 'importing' | null>(null);

  const choose = async (f: File | undefined) => {
    if (!f) return;
    setFile(f.name); setTable(null); setPlan(null); setError(null); setBusy('reading');
    try {
      const t = await readFile(f);
      setTable(t);
      setPlan(await send(t.rows, false));
    } catch (err: any) {
      setError(`${f.name} can't be imported: ${err?.message || err}`);
    } finally {
      setBusy(null);
    }
  };

  const importNow = async () => {
    if (!table) return;
    setBusy('importing');
    try {
      const done = await send(table.rows, true);
      onImported(`Imported ${file}: ${done.added} added, ${done.updated} updated, ${done.unchanged} unchanged.`);
    } catch (err: any) {
      triggerToast(`The import failed, nothing was changed: ${err?.message || err}`, 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  const shown = plan?.changes.filter((c) => c.kind !== 'unchanged') ?? [];
  const toWrite = (plan?.added ?? 0) + (plan?.updated ?? 0);

  return (
    <Modal title="Import products" subtitle="Add products and update costs and prices from a spreadsheet (.xlsx) or CSV." onClose={onClose} maxWidth="max-w-4xl">
      <div className="space-y-md text-xs">
        <div className="rounded-lg border border-outline-variant bg-surface-container-low p-sm space-y-1 text-on-surface-variant">
          <p>Columns are found by their headers: <strong>Model #</strong> (needed), and any of <strong>Description</strong>, <strong>Category</strong>, <strong>Production cost</strong>, <strong>Selling price</strong>, <strong>Notes</strong>. Prices exclude VAT; "R 8 827,89" and "8827.89" both work.</p>
          <p>A model number already in the catalogue is updated; a new one is added. An empty cell keeps what is there, so a sheet of prices alone changes only prices. Nothing is deleted.</p>
          <p>To start from the current catalogue, <button type="button" onClick={onExport} className="text-primary font-bold hover:underline">export it as a CSV</button>, edit it, and import it back.</p>
        </div>

        <label className="flex items-center gap-2 cursor-pointer w-fit rounded-lg border border-dashed border-primary/50 bg-primary/5 px-md py-sm font-bold text-primary hover:bg-primary/10">
          {busy === 'reading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileUp className="w-4 h-4" />}
          {file ? `Choose another file (${file})` : 'Choose a file'}
          <input type="file" accept=".xlsx,.xls,.csv,.txt" className="hidden" aria-label="File to import"
            onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
        </label>

        {error && <p className="text-error" role="alert">{error}</p>}

        {table && plan && (
          <>
            <div className="flex flex-wrap gap-1.5" data-testid="import-summary">
              <span className="rounded-full border border-green-500/25 bg-green-500/10 text-green-500 font-bold px-2.5 py-1">{plan.added} new</span>
              <span className="rounded-full border border-primary/25 bg-primary/10 text-primary font-bold px-2.5 py-1">{plan.updated} changed</span>
              <span className="rounded-full border border-outline-variant bg-surface-container-high text-outline font-bold px-2.5 py-1">{plan.unchanged} unchanged</span>
              <span className="text-outline self-center">{table.sheetName ? `Sheet "${table.sheetName}", ` : ''}columns: Model #{table.columns.map((c) => `, ${FIELD_LABELS[c]}`).join('')}</span>
            </div>
            {(table.notes.length > 0 || table.ignoredHeaders.length > 0) && (
              <ul className="list-disc pl-5 text-amber-500 space-y-0.5">
                {table.ignoredHeaders.length > 0 && <li>Columns not imported: {table.ignoredHeaders.join(', ')}.</li>}
                {table.notes.map((n) => <li key={n}>{n}</li>)}
              </ul>
            )}
            {shown.length > 0 && (
              <div className="max-h-80 overflow-y-auto custom-scrollbar rounded-lg border border-outline-variant">
                <table className="w-full text-left">
                  <thead className="sticky top-0 bg-surface-container-high text-[10px] uppercase text-outline">
                    <tr><th className="px-sm py-1.5">Row</th><th className="px-sm py-1.5">Model #</th><th className="px-sm py-1.5"></th><th className="px-sm py-1.5">What changes</th></tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {shown.map((c) => (
                      <tr key={c.modelNumber} data-testid={`import-row-${c.modelNumber}`} className="align-top">
                        <td className="px-sm py-1.5 text-outline font-mono">{c.line}</td>
                        <td className="px-sm py-1.5 font-mono font-bold text-primary">{c.modelNumber}</td>
                        <td className="px-sm py-1.5">{c.kind === 'new' ? <span className="text-green-500 font-bold">New</span> : <span className="text-primary font-bold">Changed</span>}</td>
                        <td className="px-sm py-1.5 space-y-0.5">
                          {(Object.keys(c.set) as Array<keyof ProductFields>).map((f) => (
                            <div key={f}>
                              <span className="text-outline">{FIELD_LABELS[f]}: </span>
                              {c.kind === 'changed' && <><span className="line-through text-outline">{show(f, c.before[f])}</span> → </>}
                              <span className="text-on-surface">{show(f, c.set[f])}</span>
                            </div>
                          ))}
                          {Object.keys(c.set).length === 0 && <span className="text-outline italic">Model number only</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {toWrite === 0 && <p className="text-on-surface-variant">Everything in the file already matches the catalogue: nothing to import.</p>}
          </>
        )}

        <div className="flex justify-end gap-sm">
          <SecondaryButton type="button" onClick={onClose}>Cancel</SecondaryButton>
          <PrimaryButton type="button" onClick={() => void importNow()} disabled={!plan || toWrite === 0 || busy !== null}
            icon={busy === 'importing' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileUp className="w-3.5 h-3.5" />}>
            {plan && toWrite ? `Import ${toWrite} product${toWrite === 1 ? '' : 's'}` : 'Import'}
          </PrimaryButton>
        </div>
      </div>
    </Modal>
  );
};
