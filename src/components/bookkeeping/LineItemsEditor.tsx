import React, { useState } from 'react';
import { Plus, Trash2, ChevronDown } from 'lucide-react';
import { Item, TaxRate, Account } from '../../types';
import { fmtMoney, inputClass, selectClass } from './shared';

export interface EditableLine {
  key: string;
  partNumber?: string;
  description: string;
  quantity: number;
  unitPrice: number;
  taxRateId: number | null;
  deductStock?: boolean;
  receiveStock?: boolean;
  accountId?: number | null;
}

export function newEditableLine(): EditableLine {
  return { key: `L${Date.now()}${Math.random().toString(36).slice(2, 6)}`, description: '', quantity: 1, unitPrice: 0, taxRateId: null };
}

export function lineTotals(line: EditableLine, taxRates: TaxRate[]) {
  const taxPct = taxRates.find(t => t.id === line.taxRateId)?.rate || 0;
  const base = (Number(line.quantity) || 0) * (Number(line.unitPrice) || 0);
  const taxAmount = Math.round(base * (taxPct / 100) * 100) / 100;
  return { base: Math.round(base * 100) / 100, taxAmount, lineTotal: Math.round((base + taxAmount) * 100) / 100 };
}

interface LineItemsEditorProps {
  lines: EditableLine[];
  onChange: (lines: EditableLine[]) => void;
  items: Item[];
  taxRates: TaxRate[];
  accounts?: Account[];
  mode: 'SALES' | 'PURCHASE';
  currency: string;
}

export const LineItemsEditor: React.FC<LineItemsEditorProps> = ({ lines, onChange, items, taxRates, accounts, mode, currency }) => {
  const [openDropdown, setOpenDropdown] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');

  const update = (key: string, patch: Partial<EditableLine>) => {
    onChange(lines.map(l => (l.key === key ? { ...l, ...patch } : l)));
  };
  const remove = (key: string) => onChange(lines.filter(l => l.key !== key));
  const add = () => onChange([...lines, newEditableLine()]);

  const onPickPart = (key: string, partNumber: string) => {
    const item = items.find(i => i.partNumber === partNumber);
    if (item) {
      update(key, {
        partNumber: item.partNumber,
        description: item.name || item.description || item.partNumber,
        unitPrice: item.price || 0,
      });
    } else {
      update(key, { partNumber });
    }
  };

  const subtotal = lines.reduce((s, l) => s + lineTotals(l, taxRates).base, 0);
  const taxTotal = lines.reduce((s, l) => s + lineTotals(l, taxRates).taxAmount, 0);
  const total = subtotal + taxTotal;

  return (
    <div className="space-y-2">
      <div className="overflow-x-auto rounded-lg border border-outline-variant/40">
        <table className="w-full text-left text-xs min-w-[720px]">
          <thead>
            <tr className="bg-surface-container-high/50 text-[10px] uppercase text-outline">
              <th className="py-2 px-2 w-36">Part # (optional)</th>
              <th className="py-2 px-2">Description</th>
              <th className="py-2 px-2 w-20 text-right">Qty</th>
              <th className="py-2 px-2 w-28 text-right">Unit Price</th>
              <th className="py-2 px-2 w-32">Tax</th>
              {mode === 'PURCHASE' && accounts && <th className="py-2 px-2 w-36">Account</th>}
              <th className="py-2 px-2 w-24 text-right">Line Total</th>
              <th className="py-2 px-2 w-28 text-center">{mode === 'SALES' ? 'Deduct Stock' : 'Receive Stock'}</th>
              <th className="py-2 px-2 w-8"></th>
            </tr>
          </thead>
          <tbody>
            {lines.map(line => {
              const t = lineTotals(line, taxRates);
              return (
                <tr key={line.key} className="border-t border-outline-variant/20">
                  <td className="p-1 relative">
                    <div className="relative">
                      <div className="flex items-center gap-1">
                        <input
                          type="text"
                          value={openDropdown === line.key ? searchQuery : line.partNumber || ''}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            setOpenDropdown(line.key);
                          }}
                          onFocus={() => {
                            setOpenDropdown(line.key);
                            setSearchQuery(line.partNumber || '');
                          }}
                          onBlur={() => setTimeout(() => setOpenDropdown(null), 150)}
                          className={`${inputClass} py-1.5 text-xs font-mono flex-1`}
                          placeholder="SKU or name"
                        />
                        <ChevronDown className="w-3.5 h-3.5 text-on-surface-variant pointer-events-none" />
                      </div>
                      {openDropdown === line.key && (
                        <div className="absolute top-full left-0 right-0 mt-1 bg-surface-container-high border border-outline-variant/40 rounded shadow-lg z-10 max-h-48 overflow-y-auto text-xs">
                          {items
                            .filter(i =>
                              !searchQuery ||
                              i.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
                              (i.name || i.description || '').toLowerCase().includes(searchQuery.toLowerCase())
                            )
                            .slice(0, 10)
                            .map(item => (
                              <button
                                key={item.partNumber}
                                type="button"
                                onClick={() => {
                                  onPickPart(line.key, item.partNumber);
                                  setOpenDropdown(null);
                                  setSearchQuery('');
                                }}
                                className="w-full text-left px-2.5 py-2 hover:bg-primary/10 border-b border-outline-variant/10 last:border-0 transition-colors"
                              >
                                <div className="font-mono font-bold text-primary">{item.partNumber}</div>
                                <div className="text-on-surface-variant truncate">{item.name || item.description || 'No description'}</div>
                                <div className="text-[10px] text-on-surface-variant/70">Stock: {item.stockLevel} • Price: ${(item.price || 0).toFixed(2)}</div>
                              </button>
                            ))}
                          {items.filter(i =>
                            !searchQuery ||
                            i.partNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            (i.name || i.description || '').toLowerCase().includes(searchQuery.toLowerCase())
                          ).length === 0 && (
                            <div className="px-2.5 py-2 text-on-surface-variant/60 italic">No components found</div>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="p-1">
                    <input
                      value={line.description}
                      onChange={(e) => update(line.key, { description: e.target.value })}
                      className={`${inputClass} py-1.5 text-xs`}
                      placeholder="Description"
                      required
                    />
                  </td>
                  <td className="p-1">
                    <input
                      type="number" min={0.01} step="0.01"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: parseFloat(e.target.value) || 0 })}
                      className={`${inputClass} py-1.5 text-xs text-right`}
                    />
                  </td>
                  <td className="p-1">
                    <input
                      type="number" min={0} step="0.01"
                      value={line.unitPrice}
                      onChange={(e) => update(line.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                      className={`${inputClass} py-1.5 text-xs text-right`}
                    />
                  </td>
                  <td className="p-1">
                    <select
                      value={line.taxRateId ?? ''}
                      onChange={(e) => update(line.key, { taxRateId: e.target.value ? Number(e.target.value) : null })}
                      className={`${selectClass} py-1.5 text-xs`}
                      aria-label="Tax rate"
                    >
                      <option value="">No tax</option>
                      {taxRates.map(tr => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                    </select>
                  </td>
                  {mode === 'PURCHASE' && accounts && (
                    <td className="p-1">
                      <select
                        value={line.accountId ?? ''}
                        onChange={(e) => update(line.key, { accountId: e.target.value ? Number(e.target.value) : null })}
                        className={`${selectClass} py-1.5 text-xs`}
                        aria-label="Expense account"
                      >
                        <option value="">Default expense</option>
                        {accounts.filter(a => a.type === 'EXPENSE' || a.type === 'ASSET').map(a => <option key={a.id} value={a.id}>{a.code} {a.name}</option>)}
                      </select>
                    </td>
                  )}
                  <td className="p-1 text-right font-mono font-bold text-on-surface">{fmtMoney(t.lineTotal, currency)}</td>
                  <td className="p-1 text-center">
                    <input
                      type="checkbox"
                      checked={mode === 'SALES' ? !!line.deductStock : !!line.receiveStock}
                      disabled={!line.partNumber}
                      onChange={(e) => update(line.key, mode === 'SALES' ? { deductStock: e.target.checked } : { receiveStock: e.target.checked })}
                      className="w-3.5 h-3.5"
                      title={line.partNumber ? 'Sync this line with inventory stock' : 'Set a part number to enable'}
                    />
                  </td>
                  <td className="p-1 text-center">
                    <button type="button" onClick={() => remove(line.key)} className="text-error/70 hover:text-error p-1" aria-label="Remove line">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <datalist id="bk-part-numbers">
        {items.map(i => <option key={i.partNumber} value={i.partNumber}>{i.name}</option>)}
      </datalist>

      <button type="button" onClick={add} className="flex items-center gap-1.5 text-xs font-bold text-primary hover:underline">
        <Plus className="w-3.5 h-3.5" /> Add line
      </button>

      <div className="flex justify-end">
        <div className="w-64 space-y-1 text-xs bg-surface-container-low rounded-lg p-3 border border-outline-variant/30">
          <div className="flex justify-between"><span className="text-on-surface-variant">Subtotal</span><span className="font-mono">{fmtMoney(subtotal, currency)}</span></div>
          <div className="flex justify-between"><span className="text-on-surface-variant">Tax</span><span className="font-mono">{fmtMoney(taxTotal, currency)}</span></div>
          <div className="flex justify-between font-bold text-sm pt-1 border-t border-outline-variant/30"><span>Total</span><span className="font-mono text-primary">{fmtMoney(total, currency)}</span></div>
        </div>
      </div>
    </div>
  );
};
