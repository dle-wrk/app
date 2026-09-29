// Bank reconciliation surface. Import a bank statement (CSV), let the
// server auto-match every line against payments_received / payments_made
// / expenses, resolve the remainder by hand, and complete the batch.
//
// The completed batch locks the header so a retroactive edit to the
// statement can't quietly rewrite the opening balance on next month's
// reconciliation.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Upload, CheckCircle2, AlertTriangle, Trash2, Zap, Loader2, Link as LinkIcon, X } from 'lucide-react';
import {
  ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate,
  apiGet, apiPost, apiDelete,
  PrimaryButton, SecondaryButton, DangerButton,
  FieldLabel, inputClass, selectClass, EmptyState, SectionCard,
} from './shared';

// ── CSV parsing (same shape KitBookingView / Supplier BOM use) ────────
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

// Every SA bank exports something slightly different. Sniff the column
// names against a small vocabulary; the operator can override in the
// preview step if we guessed wrong.
interface ColumnMap { date: number; description: number; amount: number; reference: number | null; }
function guessColumns(headers: string[]): ColumnMap {
  const lc = headers.map(h => h.toLowerCase());
  const idx = (aliases: string[]) => {
    for (const a of aliases) {
      const i = lc.findIndex(h => h.includes(a));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date: idx(['date', 'datum', 'txndate', 'trndate']),
    description: idx(['description', 'narration', 'details', 'memo']),
    amount: idx(['amount', 'value', 'bedrag']),
    reference: (() => { const i = idx(['reference', 'ref', 'note']); return i >= 0 ? i : null; })(),
  };
}

interface ParsedLine { date: string; description: string; amount: number; reference: string; }

function normalizeDate(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Already ISO?
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // dd/mm/yyyy or dd-mm-yyyy
  const m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yyyy}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return '';
}
function normalizeAmount(raw: string): number {
  const s = String(raw || '').replace(/[\s ]/g, '').replace(/,/g, '.').replace(/[^0-9.\-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export const BankRecTab: React.FC<ModuleDataProps> = (props) => {
  const { accounts, triggerToast } = props;
  const bankAccounts = accounts.filter((a: any) =>
    a.type === 'ASSET' && (a.subtype === 'BANK' || a.subtype === 'CASH' || /bank|cash|clearing/i.test(a.name || ''))
  );
  const [statements, setStatements] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showImport, setShowImport] = useState(false);
  const [openStmt, setOpenStmt] = useState<any | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await apiGet('/api/bank/statements');
      setStatements(Array.isArray(rows) ? rows : []);
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to load statements', 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  return (
    <div className="space-y-4">
      <SectionCard
        title="Bank Reconciliation"
        badge={`${statements.length} statement${statements.length === 1 ? '' : 's'}`}
        actions={<PrimaryButton icon={<Upload className="w-3.5 h-3.5" />} onClick={() => setShowImport(true)}>Import Statement</PrimaryButton>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Statement #</th>
                <th className="px-lg py-sm">Account</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm text-right">Opening</th>
                <th className="px-lg py-sm text-right">Closing</th>
                <th className="px-lg py-sm text-center">Match</th>
                <th className="px-lg py-sm">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {statements.map(s => (
                <tr key={s.id} className="hover:bg-surface-variant/20 cursor-pointer" onClick={async () => {
                  try {
                    const full = await apiGet(`/api/bank/statements/${s.id}`);
                    setOpenStmt(full);
                  } catch (err: any) {
                    triggerToast(err?.message || 'Failed to load statement', 'ERROR');
                  }
                }}>
                  <td className="px-lg py-sm font-mono text-primary font-bold">{s.statementNumber}</td>
                  <td className="px-lg py-sm">{s.accountName || `#${s.accountId}`}</td>
                  <td className="px-lg py-sm text-on-surface-variant">{fmtDate(s.statementDate)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(s.openingBalance)}</td>
                  <td className="px-lg py-sm text-right font-mono">{fmtMoney(s.closingBalance)}</td>
                  <td className="px-lg py-sm text-center text-[11px] font-mono">
                    {s.matchedCount ?? 0} / {s.lineCount ?? 0}
                  </td>
                  <td className="px-lg py-sm"><StatusPill status={s.status} /></td>
                </tr>
              ))}
              {!loading && statements.length === 0 && (
                <EmptyState message="No bank statements imported yet. Import your first CSV export from the bank to start reconciling." colSpan={7} />
              )}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showImport && (
        <ImportModal
          bankAccounts={bankAccounts}
          triggerToast={triggerToast}
          onClose={() => setShowImport(false)}
          onImported={async () => { setShowImport(false); await load(); }}
        />
      )}

      {openStmt && (
        <ReconcileModal
          statement={openStmt}
          onClose={() => setOpenStmt(null)}
          onChanged={async () => {
            const full = await apiGet(`/api/bank/statements/${openStmt.id}`);
            setOpenStmt(full);
            await load();
          }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Import modal — pick account, upload CSV, sniff columns, preview,
// then POST to /api/bank/statements.
// ─────────────────────────────────────────────────────────────────────
const ImportModal: React.FC<{
  bankAccounts: any[];
  triggerToast: (msg: string, type?: any) => void;
  onClose: () => void;
  onImported: () => void;
}> = ({ bankAccounts, triggerToast, onClose, onImported }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [accountId, setAccountId] = useState<string>(bankAccounts[0]?.id ? String(bankAccounts[0].id) : '');
  const [statementDate, setStatementDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const [filename, setFilename] = useState<string>('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [colMap, setColMap] = useState<ColumnMap>({ date: -1, description: -1, amount: -1, reference: null });
  const [openingBalance, setOpeningBalance] = useState<string>('0');
  const [closingBalance, setClosingBalance] = useState<string>('0');
  const [saving, setSaving] = useState(false);

  const parsedLines: ParsedLine[] = useMemo(() => {
    if (colMap.date < 0 || colMap.amount < 0) return [];
    return rawRows
      .map(row => ({
        date: normalizeDate(row[colMap.date] || ''),
        description: colMap.description >= 0 ? (row[colMap.description] || '').trim() : '',
        amount: normalizeAmount(row[colMap.amount] || '0'),
        reference: colMap.reference != null && colMap.reference >= 0 ? (row[colMap.reference] || '').trim() : '',
      }))
      .filter(l => l.date && l.amount !== 0);
  }, [rawRows, colMap]);

  const linesSum = useMemo(() => parsedLines.reduce((s, l) => s + l.amount, 0), [parsedLines]);
  const balanceCheck = (parseFloat(openingBalance) || 0) + linesSum;
  const closingNum = parseFloat(closingBalance) || 0;
  const balanceOk = Math.abs(balanceCheck - closingNum) < 0.02;

  const onFile = async (file: File) => {
    const text = await file.text();
    const { headers, rows } = parseCsv(text);
    setHeaders(headers);
    setRawRows(rows);
    setColMap(guessColumns(headers));
    setFilename(file.name);
  };

  const submit = async () => {
    if (!accountId) { triggerToast('Pick a bank account.', 'ERROR'); return; }
    if (parsedLines.length === 0) { triggerToast('No usable lines found in the CSV.', 'ERROR'); return; }
    if (!balanceOk) { triggerToast(`Opening + lines (${balanceCheck.toFixed(2)}) doesn't match closing (${closingNum.toFixed(2)}). Fix before importing.`, 'ERROR'); return; }
    setSaving(true);
    try {
      const created = await apiPost('/api/bank/statements', {
        accountId: Number(accountId),
        statementDate,
        openingBalance: parseFloat(openingBalance) || 0,
        closingBalance: parseFloat(closingBalance) || 0,
        filename,
        lines: parsedLines.map(l => ({ txnDate: l.date, description: l.description, amount: l.amount, reference: l.reference || undefined })),
      });
      // Auto-match immediately — one click for the common case.
      try {
        const summary = await apiPost(`/api/bank/statements/${created.id}/auto-match`, {});
        triggerToast(`Statement ${created.statementNumber} imported — ${summary.matched}/${summary.considered} lines auto-matched.`);
      } catch {
        triggerToast(`Statement ${created.statementNumber} imported.`);
      }
      onImported();
    } catch (err: any) {
      triggerToast(err?.message || 'Import failed', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Import Bank Statement" subtitle="CSV / TSV export from your bank. The importer sniffs the columns; override any guess before saving." onClose={onClose} maxWidth="max-w-4xl">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-md mb-md">
        <div className="md:col-span-2">
          <FieldLabel>Bank Account</FieldLabel>
          <select className={selectClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {bankAccounts.length === 0 && <option value="">— No bank accounts —</option>}
            {bankAccounts.map((a: any) => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
          </select>
        </div>
        <div>
          <FieldLabel>Statement Date</FieldLabel>
          <input type="date" className={inputClass} value={statementDate} onChange={(e) => setStatementDate(e.target.value)} />
        </div>
        <div>
          <FieldLabel>CSV File</FieldLabel>
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
          <SecondaryButton icon={<Upload className="w-3.5 h-3.5" />} onClick={() => fileRef.current?.click()}>Choose file</SecondaryButton>
          {filename && <div className="text-[10px] text-outline font-mono mt-1 truncate">{filename}</div>}
        </div>
      </div>

      {headers.length > 0 && (
        <div className="mb-md">
          <div className="text-xs font-bold text-outline mb-2 uppercase tracking-wider">Column mapping</div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-sm">
            {(['date', 'description', 'amount', 'reference'] as const).map(field => (
              <div key={field}>
                <FieldLabel>{field}</FieldLabel>
                <select
                  className={selectClass}
                  value={colMap[field] ?? ''}
                  onChange={(e) => setColMap({ ...colMap, [field]: e.target.value === '' ? (field === 'reference' ? null : -1) : Number(e.target.value) })}
                >
                  {field === 'reference' && <option value="">— none —</option>}
                  {headers.map((h, i) => <option key={i} value={i}>{h || `col ${i + 1}`}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-cols-3 gap-md mb-md">
        <div>
          <FieldLabel>Opening balance</FieldLabel>
          <input type="number" step="0.01" className={`${inputClass} font-mono text-right`} value={openingBalance} onChange={(e) => setOpeningBalance(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Closing balance</FieldLabel>
          <input type="number" step="0.01" className={`${inputClass} font-mono text-right`} value={closingBalance} onChange={(e) => setClosingBalance(e.target.value)} />
        </div>
        <div>
          <FieldLabel>Balance check</FieldLabel>
          <div className={`p-2 rounded border text-xs font-mono ${balanceOk ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-error/40 bg-error/10 text-error'}`}>
            Opening + lines = <span className="font-bold">{balanceCheck.toFixed(2)}</span>
            <br />
            Δ vs closing: <span className="font-bold">{(balanceCheck - closingNum).toFixed(2)}</span>
          </div>
        </div>
      </div>

      {parsedLines.length > 0 && (
        <div className="rounded-lg border border-outline-variant/40 max-h-64 overflow-y-auto mb-md">
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-container-high/60 text-outline text-[10px] uppercase sticky top-0">
              <tr>
                <th className="px-md py-1.5">Date</th>
                <th className="px-md py-1.5">Description</th>
                <th className="px-md py-1.5">Reference</th>
                <th className="px-md py-1.5 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {parsedLines.slice(0, 20).map((l, idx) => (
                <tr key={idx} className="border-t border-outline-variant/20">
                  <td className="px-md py-1.5 font-mono">{l.date}</td>
                  <td className="px-md py-1.5">{l.description}</td>
                  <td className="px-md py-1.5 font-mono text-outline">{l.reference || '—'}</td>
                  <td className={`px-md py-1.5 text-right font-mono ${l.amount < 0 ? 'text-error' : 'text-green-400'}`}>{fmtMoney(l.amount)}</td>
                </tr>
              ))}
              {parsedLines.length > 20 && (
                <tr><td colSpan={4} className="px-md py-1.5 text-center text-outline italic text-[10px]">…and {parsedLines.length - 20} more</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose} disabled={saving}>Cancel</SecondaryButton>
        <PrimaryButton icon={<Upload className="w-3.5 h-3.5" />} onClick={submit} disabled={saving || parsedLines.length === 0}>{saving ? 'Importing…' : `Import ${parsedLines.length} lines`}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Reconcile modal — the reconciliation grid: statement lines, match
// status, per-row actions (Pick candidate / Ignore / Unmatch), header
// strip showing balance progress + Complete button.
// ─────────────────────────────────────────────────────────────────────
const ReconcileModal: React.FC<{
  statement: any;
  onClose: () => void;
  onChanged: () => void;
  triggerToast: (msg: string, type?: any) => void;
}> = ({ statement, onClose, onChanged, triggerToast }) => {
  const [pickingLine, setPickingLine] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);

  const totals = useMemo(() => {
    const lines = statement.lines || [];
    const sum = lines.reduce((s: number, l: any) => s + (Number(l.amount) || 0), 0);
    const matched = lines.filter((l: any) => l.matchedType).length;
    return {
      sum,
      matched,
      total: lines.length,
      expected: (Number(statement.openingBalance) || 0) + sum,
      diff: ((Number(statement.openingBalance) || 0) + sum) - (Number(statement.closingBalance) || 0),
    };
  }, [statement]);

  const runAutoMatch = async () => {
    setBusy(true);
    try {
      const r = await apiPost(`/api/bank/statements/${statement.id}/auto-match`, {});
      triggerToast(`Auto-match: ${r.matched} newly matched out of ${r.considered} open lines.`);
      await onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Auto-match failed', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const unmatch = async (lineId: number) => {
    try {
      await apiPost(`/api/bank/statement-lines/${lineId}/unmatch`, {});
      await onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to unmatch', 'ERROR');
    }
  };

  const setManual = async (lineId: number, note: string) => {
    try {
      await apiPost(`/api/bank/statement-lines/${lineId}/match`, { matchedType: 'MANUAL', notes: note });
      await onChanged();
    } catch (err: any) {
      triggerToast(err?.message || 'Failed to mark manual', 'ERROR');
    }
  };

  const complete = async (force = false) => {
    setBusy(true);
    try {
      await apiPost(`/api/bank/statements/${statement.id}/complete`, force ? { force: true } : {});
      triggerToast(`Statement ${statement.statementNumber} reconciled.`);
      onClose();
    } catch (err: any) {
      // Server tells us WHY (balance mismatch vs unmatched); relay verbatim.
      triggerToast(err?.message || 'Failed to complete', 'ERROR');
    } finally {
      setBusy(false);
    }
  };

  const isLocked = statement.status !== 'DRAFT';

  return (
    <Modal title={`${statement.statementNumber} · ${statement.accountName || ''}`} subtitle={`${fmtDate(statement.statementDate)} · Opening ${fmtMoney(statement.openingBalance)} → Closing ${fmtMoney(statement.closingBalance)}`} onClose={onClose} maxWidth="max-w-6xl">
      {/* Progress strip */}
      <div className="grid grid-cols-4 gap-sm mb-md">
        <div className="p-2.5 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Matched</div>
          <div className="font-mono font-bold text-primary">{totals.matched} / {totals.total}</div>
        </div>
        <div className="p-2.5 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Lines sum</div>
          <div className="font-mono font-bold">{fmtMoney(totals.sum)}</div>
        </div>
        <div className="p-2.5 rounded-lg border border-outline-variant/40 bg-surface-container-low">
          <div className="text-[10px] uppercase text-outline">Expected closing</div>
          <div className="font-mono font-bold">{fmtMoney(totals.expected)}</div>
        </div>
        <div className={`p-2.5 rounded-lg border ${Math.abs(totals.diff) < 0.02 ? 'border-green-500/40 bg-green-500/10 text-green-400' : 'border-error/40 bg-error/10 text-error'}`}>
          <div className="text-[10px] uppercase">Diff vs closing</div>
          <div className="font-mono font-bold">{fmtMoney(totals.diff)}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-md">
        {!isLocked && <SecondaryButton icon={<Zap className="w-3.5 h-3.5" />} onClick={runAutoMatch} disabled={busy}>Auto-match unmatched</SecondaryButton>}
        <StatusPill status={statement.status} />
        <div className="flex-1" />
        {!isLocked && <PrimaryButton icon={<CheckCircle2 className="w-3.5 h-3.5" />} onClick={() => complete(false)} disabled={busy}>Complete</PrimaryButton>}
      </div>

      <div className="rounded-lg border border-outline-variant/40 overflow-hidden max-h-[55vh] overflow-y-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-surface-container-high/60 text-outline text-[10px] uppercase sticky top-0">
            <tr>
              <th className="px-md py-2">Date</th>
              <th className="px-md py-2">Description</th>
              <th className="px-md py-2">Ref</th>
              <th className="px-md py-2 text-right">Amount</th>
              <th className="px-md py-2">Match</th>
              <th className="px-md py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(statement.lines || []).map((l: any) => (
              <tr key={l.id} className={`border-t border-outline-variant/20 ${l.matchedType ? '' : 'bg-error/5'}`}>
                <td className="px-md py-1.5 font-mono">{fmtDate(l.txnDate)}</td>
                <td className="px-md py-1.5 max-w-[280px]"><div className="truncate" title={l.description}>{l.description}</div></td>
                <td className="px-md py-1.5 font-mono text-outline text-[10px]">{l.reference || '—'}</td>
                <td className={`px-md py-1.5 text-right font-mono ${l.amount < 0 ? 'text-error' : 'text-green-400'}`}>{fmtMoney(l.amount)}</td>
                <td className="px-md py-1.5">
                  {l.matchedType ? (
                    <div className="flex items-center gap-1.5">
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold uppercase bg-primary/10 text-primary border border-primary/25">
                        <LinkIcon className="w-2.5 h-2.5" />
                        {l.matchedType === 'PAYMENT_IN' ? 'Received' : l.matchedType === 'PAYMENT_OUT' ? 'Paid' : l.matchedType === 'EXPENSE' ? 'Expense' : 'Manual'}
                      </span>
                      {l.matchDocNumber && <span className="font-mono text-[10px] text-primary">{l.matchDocNumber}</span>}
                      {l.matchCounterparty && <span className="text-[10px] text-on-surface-variant">· {l.matchCounterparty}</span>}
                      {l.matchConfidence != null && l.matchConfidence < 1 && (
                        <span className="text-[9px] text-outline" title="Auto-match confidence">({Math.round(l.matchConfidence * 100)}%)</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-[10px] italic text-error">Unmatched</span>
                  )}
                </td>
                <td className="px-md py-1.5 text-right">
                  {!isLocked && (
                    l.matchedType
                      ? <button className="text-[10px] text-outline hover:text-error underline" onClick={() => unmatch(l.id)}>Unmatch</button>
                      : (
                        <div className="inline-flex items-center gap-1">
                          <button className="text-[10px] text-primary hover:underline font-bold" onClick={() => setPickingLine(l)}>Pick…</button>
                          <span className="text-outline text-[10px]">·</span>
                          <button className="text-[10px] text-outline hover:text-on-surface underline" onClick={() => setManual(l.id, 'Ignored during reconciliation')}>Ignore</button>
                        </div>
                      )
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {pickingLine && (
        <PickCandidateModal
          line={pickingLine}
          accountId={statement.accountId}
          onClose={() => setPickingLine(null)}
          onPicked={async () => { setPickingLine(null); await onChanged(); }}
          triggerToast={triggerToast}
        />
      )}
    </Modal>
  );
};

// ─────────────────────────────────────────────────────────────────────
// Pick a candidate to match a line against. Server picker feed filters
// out already-matched rows so the operator never accidentally
// double-matches. Buckets by type (received / paid / expense) with
// tabs; default bucket is chosen from the sign of the amount.
// ─────────────────────────────────────────────────────────────────────
const PickCandidateModal: React.FC<{
  line: any;
  accountId: number;
  onClose: () => void;
  onPicked: () => void;
  triggerToast: (msg: string, type?: any) => void;
}> = ({ line, accountId, onClose, onPicked, triggerToast }) => {
  const inflow = Number(line.amount) > 0;
  const [type, setType] = useState<'PAYMENT_IN' | 'PAYMENT_OUT' | 'EXPENSE'>(inflow ? 'PAYMENT_IN' : 'PAYMENT_OUT');
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    apiGet(`/api/bank/candidates?type=${type}&accountId=${accountId}&amount=${Math.abs(Number(line.amount))}`)
      .then(r => { if (!cancelled) setRows(Array.isArray(r) ? r : []); })
      .catch(() => { if (!cancelled) setRows([]); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [type, accountId, line.amount]);

  const pick = async (targetId: number) => {
    try {
      await apiPost(`/api/bank/statement-lines/${line.id}/match`, { matchedType: type, matchedId: targetId });
      onPicked();
    } catch (err: any) {
      triggerToast(err?.message || 'Match failed', 'ERROR');
    }
  };

  return (
    <Modal title="Match line" subtitle={`${fmtDate(line.txnDate)} · ${line.description} · ${fmtMoney(line.amount)}`} onClose={onClose} maxWidth="max-w-2xl">
      <div className="flex items-center gap-1 mb-md">
        {(['PAYMENT_IN', 'PAYMENT_OUT', 'EXPENSE'] as const).map(t => (
          <button
            key={t}
            onClick={() => setType(t)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${type === t ? 'bg-primary text-white' : 'bg-surface-container-high text-on-surface-variant hover:bg-surface-container-highest'}`}
          >
            {t === 'PAYMENT_IN' ? 'Payment received' : t === 'PAYMENT_OUT' ? 'Payment made' : 'Expense'}
          </button>
        ))}
      </div>
      <div className="rounded-lg border border-outline-variant/40 max-h-[50vh] overflow-y-auto">
        {loading ? (
          <div className="p-6 text-center text-xs text-outline"><Loader2 className="w-4 h-4 inline animate-spin mr-2" /> Finding candidates…</div>
        ) : rows.length === 0 ? (
          <div className="p-6 text-center text-xs text-outline italic">No unmatched {type.replace('_', ' ').toLowerCase()} rows near this amount.</div>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="bg-surface-container-high/60 text-outline text-[10px] uppercase">
              <tr>
                <th className="px-md py-2">Doc #</th>
                <th className="px-md py-2">Date</th>
                <th className="px-md py-2">Counterparty</th>
                <th className="px-md py-2 text-right">Amount</th>
                <th className="px-md py-2 text-right"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className="border-t border-outline-variant/20 hover:bg-surface-variant/20">
                  <td className="px-md py-1.5 font-mono text-primary font-bold">{r.payment_number}</td>
                  <td className="px-md py-1.5">{fmtDate(r.payment_date)}</td>
                  <td className="px-md py-1.5">{r.counterparty || '—'}</td>
                  <td className="px-md py-1.5 text-right font-mono">{fmtMoney(r.amount)}</td>
                  <td className="px-md py-1.5 text-right">
                    <button className="text-[11px] font-bold text-primary hover:underline" onClick={() => pick(r.id)}>Match</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Modal>
  );
};
