import React, { useState } from 'react';
import { Plus, Trash2, ChevronDown, Copy } from 'lucide-react';
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
    try {
      onChange(lines.map(l => (l.key === key ? { ...l, ...patch } : l)));
    } catch (err) {
      console.error('Error in update:', err);
    }
  };
  const remove = (key: string) => {
    try {
      onChange(lines.filter(l => l.key !== key));
    } catch (err) {
      console.error('Error in remove:', err);
    }
  };
  const add = () => {
    try {
      onChange([...lines, newEditableLine()]);
    } catch (err) {
      console.error('Error in add:', err);
    }
  };

  const onPickPart = (key: string, partNumber: string) => {
    try {
      const item = items?.find(i => i?.partNumber === partNumber);
      if (item) {
        update(key, {
          partNumber: item.partNumber,
          description: item.name || item.description || item.partNumber,
          unitPrice: item.price || 0,
        });
      } else {
        update(key, { partNumber });
      }
    } catch (err) {
      console.error('Error in onPickPart:', err);
    }
  };

  const subtotal = lines.reduce((s, l) => s + lineTotals(l, taxRates).base, 0);
  const taxTotal = lines.reduce((s, l) => s + lineTotals(l, taxRates).taxAmount, 0);
  const total = subtotal + taxTotal;

  return (
    <div className="space-y-4">
      {/* Line Items */}
      <div className="space-y-3">
        {lines.length === 0 ? (
          <div className="text-center py-8 rounded-lg border-2 border-dashed border-outline-variant/40">
            <p className="text-sm text-on-surface-variant">No line items yet</p>
            <p className="text-xs text-on-surface-variant/60 mt-1">Click "Add line" to get started</p>
          </div>
        ) : (
          lines.map((line, idx) => {
            const t = lineTotals(line, taxRates);
            return (
              <div key={line.key} className="bg-surface-container border border-outline-variant/40 rounded-lg p-4 space-y-4 hover:border-outline-variant/60 transition-colors">
                {/* Header with index and remove button */}
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs font-semibold text-outline uppercase tracking-wide">Line {idx + 1}</span>
                  <button
                    type="button"
                    onClick={() => remove(line.key)}
                    className="text-error/60 hover:text-error hover:bg-error/10 p-2 rounded transition-colors"
                    title="Remove line"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Part Number & Description Row */}
                <div className="grid md:grid-cols-2 gap-3">
                  <div className="relative">
                    <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">SKU / Part #</label>
                    <div className="relative">
                      <div className="flex items-center gap-2">
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
                          onBlur={() => setTimeout(() => setOpenDropdown(null), 200)}
                          className={`${inputClass} py-2.5 px-3 text-sm font-mono flex-1`}
                          placeholder="Type to search..."
                          autoComplete="off"
                        />
                        <ChevronDown className="w-4 h-4 text-on-surface-variant pointer-events-none" />
                      </div>
                      {openDropdown === line.key && items && Array.isArray(items) && (
                        <div className="absolute top-full left-0 right-0 mt-2 bg-surface-container-high border border-outline-variant/40 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                          {(() => {
                            try {
                              const filtered = items
                                .filter((i: any) =>
                                  !searchQuery ||
                                  (i?.partNumber?.toLowerCase?.().includes(searchQuery.toLowerCase())) ||
                                  ((i?.name || i?.description || '').toLowerCase().includes(searchQuery.toLowerCase()))
                                )
                                .slice(0, 12);

                              return filtered.length > 0 ? (
                                filtered.map((item: any) => (
                                  <button
                                    key={item?.partNumber || Math.random()}
                                    type="button"
                                    onMouseDown={(e) => {
                                      e.preventDefault();
                                      if (item?.partNumber) {
                                        onPickPart(line.key, item.partNumber);
                                      }
                                      setOpenDropdown(null);
                                      setSearchQuery('');
                                    }}
                                    className="w-full text-left px-3.5 py-3 hover:bg-primary/10 border-b border-outline-variant/10 last:border-0 transition-colors"
                                  >
                                    <div className="flex items-center justify-between mb-1">
                                      <span className="font-mono font-bold text-primary text-sm">{item?.partNumber || 'N/A'}</span>
                                      <span className="text-xs text-on-surface-variant/60">${(item?.price || 0).toFixed(2)}</span>
                                    </div>
                                    <div className="text-sm text-on-surface-variant truncate">{item?.name || item?.description || 'No description'}</div>
                                    <div className="text-xs text-on-surface-variant/60 mt-1">Stock: {item?.stockLevel || 0}</div>
                                  </button>
                                ))
                              ) : (
                                <div className="px-3.5 py-3 text-on-surface-variant/60 italic text-sm">No components found</div>
                              );
                            } catch (err) {
                              console.error('Error filtering items:', err);
                              return <div className="px-3.5 py-3 text-error text-sm">Error loading items</div>;
                            }
                          })()}
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">Description</label>
                    <input
                      value={line.description}
                      onChange={(e) => update(line.key, { description: e.target.value })}
                      className={`${inputClass} py-2.5 px-3 text-sm w-full`}
                      placeholder="Item description..."
                      required
                    />
                  </div>
                </div>

                {/* Quantity, Price, Tax Row */}
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">Qty</label>
                    <input
                      type="number"
                      min={0.01}
                      step="0.01"
                      value={line.quantity}
                      onChange={(e) => update(line.key, { quantity: parseFloat(e.target.value) || 0 })}
                      className={`${inputClass} py-2.5 px-3 text-sm text-center w-full`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">Unit Price</label>
                    <input
                      type="number"
                      min={0}
                      step="0.01"
                      value={line.unitPrice}
                      onChange={(e) => update(line.key, { unitPrice: parseFloat(e.target.value) || 0 })}
                      className={`${inputClass} py-2.5 px-3 text-sm text-right font-mono w-full`}
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">Tax</label>
                    <select
                      value={line.taxRateId ?? ''}
                      onChange={(e) => update(line.key, { taxRateId: e.target.value ? Number(e.target.value) : null })}
                      className={`${selectClass} py-2.5 px-3 text-sm w-full`}
                    >
                      <option value="">No tax</option>
                      {taxRates.map(tr => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
                    </select>
                  </div>
                </div>

                {/* Additional Options */}
                <div className="grid grid-cols-2 gap-3 pt-2 border-t border-outline-variant/20">
                  {mode === 'PURCHASE' && accounts && (
                    <div>
                      <label className="block text-xs font-semibold text-outline mb-1.5 uppercase tracking-wide">Account</label>
                      <select
                        value={line.accountId ?? ''}
                        onChange={(e) => update(line.key, { accountId: e.target.value ? Number(e.target.value) : null })}
                        className={`${selectClass} py-2.5 px-3 text-xs w-full`}
                      >
                        <option value="">Default expense</option>
                        {accounts.filter(a => a.type === 'EXPENSE' || a.type === 'ASSET').map(a => (
                          <option key={a.id} value={a.id}>{a.code} {a.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className="flex items-end">
                    <label className="flex items-center gap-2 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={mode === 'SALES' ? !!line.deductStock : !!line.receiveStock}
                        disabled={!line.partNumber}
                        onChange={(e) => update(line.key, mode === 'SALES' ? { deductStock: e.target.checked } : { receiveStock: e.target.checked })}
                        className="w-4 h-4"
                        title={line.partNumber ? 'Sync inventory' : 'Set a part number first'}
                      />
                      <span className="text-xs text-on-surface-variant">{mode === 'SALES' ? 'Deduct stock' : 'Receive stock'}</span>
                    </label>
                  </div>
                </div>

                {/* Line Total */}
                <div className="flex items-center justify-between p-3 bg-primary/5 rounded-lg border border-primary/10">
                  <div className="text-sm text-on-surface-variant">Subtotal + Tax</div>
                  <div className="text-right">
                    <div className="text-xs text-on-surface-variant/60">{fmtMoney(t.base, currency)} + {fmtMoney(t.taxAmount, currency)}</div>
                    <div className="text-lg font-bold text-primary font-mono">{fmtMoney(t.lineTotal, currency)}</div>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Line Button */}
      <button
        type="button"
        onClick={add}
        className="w-full py-3 px-4 rounded-lg border-2 border-dashed border-outline-variant/40 hover:border-primary/60 hover:bg-primary/5 text-primary font-semibold text-sm transition-all flex items-center justify-center gap-2"
      >
        <Plus className="w-4 h-4" />
        Add line
      </button>

      {/* Summary */}
      {lines.length > 0 && (
        <div className="bg-surface-container-high rounded-lg p-4 space-y-2 border border-outline-variant/40">
          <div className="flex justify-between items-center text-sm">
            <span className="text-on-surface-variant">Subtotal</span>
            <span className="font-mono font-semibold">{fmtMoney(subtotal, currency)}</span>
          </div>
          <div className="flex justify-between items-center text-sm">
            <span className="text-on-surface-variant">Tax</span>
            <span className="font-mono font-semibold text-primary">{fmtMoney(taxTotal, currency)}</span>
          </div>
          <div className="flex justify-between items-center text-base border-t border-outline-variant/20 pt-2">
            <span className="font-bold text-on-surface">Total</span>
            <span className="font-mono font-bold text-lg text-primary">{fmtMoney(total, currency)}</span>
          </div>
        </div>
      )}
    </div>
  );
};
