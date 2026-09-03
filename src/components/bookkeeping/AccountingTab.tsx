import React, { useEffect, useState } from 'react';
import { Plus, Ban, ChevronDown, ChevronRight as ChevronRightIcon } from 'lucide-react';
import { Account } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtMoney, fmtDate, todayISO, apiGet, apiPost, apiPut, apiDelete, PrimaryButton, SecondaryButton, DangerButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';
import { confirmDialog } from '../../lib/confirmDialog';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'] as const;

export const AccountingTab: React.FC<ModuleDataProps> = (props) => {
  const [subTab, setSubTab] = useState<'ACCOUNTS' | 'JOURNAL'>('ACCOUNTS');
  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-surface-container-high/40 p-1 rounded-lg w-fit">
        {(['ACCOUNTS', 'JOURNAL'] as const).map(t => (
          <button key={t} onClick={() => setSubTab(t)} className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${subTab === t ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>
            {t === 'ACCOUNTS' ? 'Chart of Accounts' : 'Journal / General Ledger'}
          </button>
        ))}
      </div>
      {subTab === 'ACCOUNTS' ? <ChartOfAccountsPanel {...props} /> : <JournalPanel {...props} />}
    </div>
  );
};

const ChartOfAccountsPanel: React.FC<ModuleDataProps> = ({ accounts, triggerToast, refresh }) => {
  const [showCreate, setShowCreate] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const toggleActive = async (acct: Account) => {
    setBusy(acct.id);
    try {
      await apiPut(`/api/accounts/${acct.id}`, { isActive: !acct.isActive });
      await refresh();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to update account', 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  const remove = async (acct: Account) => {
    if (!(await confirmDialog({ title: 'Delete account', message: `Delete account ${acct.code} ${acct.name}?`, confirmLabel: 'Delete', destructive: true }))) return;
    setBusy(acct.id);
    try {
      await apiDelete(`/api/accounts/${acct.id}`);
      triggerToast('Account deleted.');
      await refresh();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to delete account', 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  const grouped = ACCOUNT_TYPES.map(type => ({ type, list: accounts.filter(a => a.type === type) }));

  return (
    <div className="space-y-4">
      <SectionCard title="Chart of Accounts" badge={`${accounts.length} accounts`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Account</PrimaryButton>}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Code</th>
                <th className="px-lg py-sm">Name</th>
                <th className="px-lg py-sm">Subtype</th>
                <th className="px-lg py-sm">Normal Balance</th>
                <th className="px-lg py-sm">Status</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {grouped.map(g => g.list.length > 0 && (
                <React.Fragment key={g.type}>
                  <tr className="bg-surface-container-high/20"><td colSpan={6} className="px-lg py-1.5 text-[10px] font-bold text-primary uppercase tracking-wider">{g.type}</td></tr>
                  {g.list.map(a => (
                    <tr key={a.id} className="hover:bg-surface-variant/20 transition-all">
                      <td className="px-lg py-sm font-mono text-on-surface-variant">{a.code}</td>
                      <td className="px-lg py-sm font-semibold">{a.name}{a.isSystem && <span className="ml-2 text-[9px] text-outline font-bold uppercase">system</span>}</td>
                      <td className="px-lg py-sm text-on-surface-variant">{a.subtype || '—'}</td>
                      <td className="px-lg py-sm text-on-surface-variant">{a.normalBalance}</td>
                      <td className="px-lg py-sm"><StatusPill status={a.isActive ? 'ACTIVE' : 'INACTIVE'} /></td>
                      <td className="px-lg py-sm text-right">
                        <div className="flex justify-end gap-1">
                          <SecondaryButton onClick={() => toggleActive(a)} disabled={busy === a.id} className="py-1">{a.isActive ? 'Deactivate' : 'Activate'}</SecondaryButton>
                          {!a.isSystem && <DangerButton onClick={() => remove(a)} disabled={busy === a.id} className="py-1">Delete</DangerButton>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </React.Fragment>
              ))}
              {accounts.length === 0 && <EmptyState message="No accounts yet." colSpan={6} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showCreate && <CreateAccountModal triggerToast={triggerToast} onClose={() => setShowCreate(false)} onSaved={async () => { setShowCreate(false); await refresh(); }} />}
    </div>
  );
};

const CreateAccountModal: React.FC<{ triggerToast: ModuleDataProps['triggerToast']; onClose: () => void; onSaved: () => void }> = ({ triggerToast, onClose, onSaved }) => {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [type, setType] = useState<typeof ACCOUNT_TYPES[number]>('EXPENSE');
  const [subtype, setSubtype] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!code || !name) { triggerToast('Code and name are required.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/accounts', { code, name, type, subtype, description });
      triggerToast('Account created.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to create account', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="New Account" onClose={onClose} maxWidth="max-w-md">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <FieldLabel>Code</FieldLabel>
          <input className={inputClass} value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. 6100" />
        </div>
        <div>
          <FieldLabel>Type</FieldLabel>
          <select className={selectClass} value={type} onChange={(e) => setType(e.target.value as any)}>
            {ACCOUNT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="col-span-2">
          <FieldLabel>Name</FieldLabel>
          <input className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Software Subscriptions" />
        </div>
        <div className="col-span-2">
          <FieldLabel hint="e.g. BANK, CASH, OPERATING_EXPENSE, FIXED_ASSET">Subtype</FieldLabel>
          <input className={inputClass} value={subtype} onChange={(e) => setSubtype(e.target.value)} />
        </div>
        <div className="col-span-2">
          <FieldLabel>Description</FieldLabel>
          <textarea className={inputClass} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Create Account'}</PrimaryButton>
      </div>
    </Modal>
  );
};

// ============================================================================
// JOURNAL / GENERAL LEDGER
// ============================================================================

const JournalPanel: React.FC<ModuleDataProps> = ({ accounts, triggerToast }) => {
  const [entries, setEntries] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedLines, setExpandedLines] = useState<any[]>([]);
  const [showManual, setShowManual] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const rows = await apiGet('/api/journal-entries?limit=300');
      setEntries(rows);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load journal', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggleExpand = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    try {
      const full = await apiGet(`/api/journal-entries/${id}`);
      setExpandedLines(full.lines || []);
      setExpandedId(id);
    } catch (err: any) {
      triggerToast(err.message || 'Failed to load entry', 'ERROR');
    }
  };

  return (
    <div className="space-y-4">
      <SectionCard title="General Ledger" badge={`${entries.length} entries`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowManual(true)}>Manual Entry</PrimaryButton>}>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm w-6"></th>
                <th className="px-lg py-sm">Entry #</th>
                <th className="px-lg py-sm">Date</th>
                <th className="px-lg py-sm">Memo</th>
                <th className="px-lg py-sm">Source</th>
                <th className="px-lg py-sm text-right">Debit</th>
                <th className="px-lg py-sm text-right">Credit</th>
                <th className="px-lg py-sm">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {entries.map(e => (
                <React.Fragment key={e.id}>
                  <tr className="hover:bg-surface-variant/20 transition-all cursor-pointer" onClick={() => toggleExpand(e.id)}>
                    <td className="px-lg py-sm">{expandedId === e.id ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRightIcon className="w-3.5 h-3.5" />}</td>
                    <td className="px-lg py-sm font-mono text-primary font-bold">{e.entryNumber}</td>
                    <td className="px-lg py-sm text-on-surface-variant">{fmtDate(e.entryDate)}</td>
                    <td className="px-lg py-sm">{e.memo || '—'}</td>
                    <td className="px-lg py-sm text-on-surface-variant">{e.sourceType}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtMoney(e.totalDebit)}</td>
                    <td className="px-lg py-sm text-right font-mono">{fmtMoney(e.totalCredit)}</td>
                    <td className="px-lg py-sm"><StatusPill status={e.status} /></td>
                  </tr>
                  {expandedId === e.id && (
                    <tr>
                      <td colSpan={8} className="px-lg pb-3 bg-surface-container-low/50">
                        <table className="w-full text-left text-[11px] mt-1">
                          <thead><tr className="text-outline"><th className="py-1 px-2">Account</th><th className="py-1 px-2">Description</th><th className="py-1 px-2 text-right">Debit</th><th className="py-1 px-2 text-right">Credit</th></tr></thead>
                          <tbody>
                            {expandedLines.map((l: any) => (
                              <tr key={l.id} className="border-t border-outline-variant/20">
                                <td className="py-1 px-2 font-mono">{l.accountCode} {l.accountName}</td>
                                <td className="py-1 px-2 text-on-surface-variant">{l.description || '—'}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.debit > 0 ? fmtMoney(l.debit) : ''}</td>
                                <td className="py-1 px-2 text-right font-mono">{l.credit > 0 ? fmtMoney(l.credit) : ''}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
              {!loading && entries.length === 0 && <EmptyState message="No journal entries yet — they're created automatically when you finalize invoices, bills, payments, or expenses." colSpan={8} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {showManual && <ManualJournalModal accounts={accounts} triggerToast={triggerToast} onClose={() => setShowManual(false)} onSaved={async () => { setShowManual(false); await load(); }} />}
    </div>
  );
};

const ManualJournalModal: React.FC<{ accounts: Account[]; triggerToast: ModuleDataProps['triggerToast']; onClose: () => void; onSaved: () => void }> = ({ accounts, triggerToast, onClose, onSaved }) => {
  const [entryDate, setEntryDate] = useState(todayISO());
  const [memo, setMemo] = useState('');
  const [lines, setLines] = useState([{ accountId: '', debit: 0, credit: 0, description: '' }, { accountId: '', debit: 0, credit: 0, description: '' }]);
  const [saving, setSaving] = useState(false);

  const totalDebit = lines.reduce((s, l) => s + (Number(l.debit) || 0), 0);
  const totalCredit = lines.reduce((s, l) => s + (Number(l.credit) || 0), 0);
  const balanced = Math.abs(totalDebit - totalCredit) < 0.01 && totalDebit > 0;

  const updateLine = (idx: number, patch: Partial<typeof lines[0]>) => {
    setLines(prev => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)));
  };

  const submit = async () => {
    if (!balanced) { triggerToast('Debits and credits must balance before posting.', 'ERROR'); return; }
    const validLines = lines.filter(l => l.accountId && (l.debit > 0 || l.credit > 0));
    if (validLines.length < 2) { triggerToast('At least two lines are required.', 'ERROR'); return; }
    setSaving(true);
    try {
      await apiPost('/api/journal-entries', {
        entryDate, memo,
        lines: validLines.map(l => ({ accountId: Number(l.accountId), debit: l.debit || 0, credit: l.credit || 0, description: l.description })),
      });
      triggerToast('Journal entry posted.');
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to post journal entry', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Manual Journal Entry" subtitle="For adjustments, corrections, or opening balances. Debits must equal credits." onClose={onClose} maxWidth="max-w-2xl">
      <div className="grid grid-cols-2 gap-3 mb-md">
        <div><FieldLabel>Date</FieldLabel><input type="date" className={inputClass} value={entryDate} onChange={(e) => setEntryDate(e.target.value)} /></div>
        <div><FieldLabel>Memo</FieldLabel><input className={inputClass} value={memo} onChange={(e) => setMemo(e.target.value)} /></div>
      </div>

      <div className="space-y-2">
        {lines.map((l, idx) => (
          <div key={idx} className="grid grid-cols-12 gap-2 items-center">
            <select className={`${selectClass} col-span-4 py-1.5 text-xs`} value={l.accountId} onChange={(e) => updateLine(idx, { accountId: e.target.value })} aria-label="Account">
              <option value="">Account</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
            </select>
            <input className={`${inputClass} col-span-3 py-1.5 text-xs`} placeholder="Description" value={l.description} onChange={(e) => updateLine(idx, { description: e.target.value })} />
            <input type="number" min={0} step="0.01" className={`${inputClass} col-span-2 py-1.5 text-xs text-right`} placeholder="Debit" value={l.debit || ''} onChange={(e) => updateLine(idx, { debit: parseFloat(e.target.value) || 0, credit: 0 })} />
            <input type="number" min={0} step="0.01" className={`${inputClass} col-span-2 py-1.5 text-xs text-right`} placeholder="Credit" value={l.credit || ''} onChange={(e) => updateLine(idx, { credit: parseFloat(e.target.value) || 0, debit: 0 })} />
            <button type="button" onClick={() => setLines(prev => prev.filter((_, i) => i !== idx))} className="col-span-1 text-error/70 hover:text-error text-xs">✕</button>
          </div>
        ))}
      </div>
      <button type="button" onClick={() => setLines(prev => [...prev, { accountId: '', debit: 0, credit: 0, description: '' }])} className="text-xs font-bold text-primary hover:underline mt-2">+ Add line</button>

      <div className={`flex justify-between mt-md pt-md border-t border-outline-variant/20 text-xs font-mono ${balanced ? 'text-green-400' : 'text-error'}`}>
        <span>Debits: {fmtMoney(totalDebit)}</span>
        <span>Credits: {fmtMoney(totalCredit)}</span>
        <span className="font-bold">{balanced ? 'Balanced ✓' : 'Not balanced'}</span>
      </div>

      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving || !balanced}>{saving ? 'Posting...' : 'Post Entry'}</PrimaryButton>
      </div>
    </Modal>
  );
};
