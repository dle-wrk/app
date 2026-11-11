import React, { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Supplier } from '../../types';
import { ModuleDataProps, fmtMoney, EmptyState, SectionCard } from './shared';
import { Vendor360Modal } from './Vendor360Modal';
import { hasBanking, maskAccount } from '../../lib/supplierBanking';

export const VendorsTab: React.FC<ModuleDataProps> = ({ suppliers, bills, purchaseOrders, paymentsMade, expenses }) => {
  const [viewing, setViewing] = useState<Supplier | null>(null);

  const balances = useMemo(() => {
    const map = new Map<string, number>();
    for (const bill of bills) {
      if (bill.status === 'VOID' || bill.status === 'DRAFT') continue;
      const key = bill.supplierId || '';
      map.set(key, (map.get(key) || 0) + bill.balanceDue);
    }
    return map;
  }, [bills]);

  return (
    <>
      <SectionCard
        title="Vendors"
        badge={`${suppliers.length} suppliers`}
        actions={<span className="text-[10px] text-outline">Edit contact and banking details on the Suppliers page</span>}
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse text-xs">
            <thead>
              <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">ID</th>
                <th className="px-lg py-sm">Name</th>
                <th className="px-lg py-sm">Contact</th>
                <th className="px-lg py-sm">Banking</th>
                <th className="px-lg py-sm text-right">Lead Time</th>
                <th className="px-lg py-sm text-right">AP Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30">
              {suppliers.map(s => (
                <tr
                  key={s.id}
                  className="hover:bg-surface-variant/20 transition-all cursor-pointer"
                  onClick={() => setViewing(s)}
                >
                  <td className="px-lg py-sm font-mono text-outline">{s.id}</td>
                  <td className="px-lg py-sm font-bold">
                    {s.name}
                    {/* Website is an outbound link — stop the row-click handler
                        so opening the vendor's site doesn't ALSO pop the drawer. */}
                    {s.website && (
                      <a
                        href={s.website}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-block ml-1.5 text-primary align-middle"
                      >
                        <ExternalLink className="w-3 h-3 inline" />
                      </a>
                    )}
                  </td>
                  <td className="px-lg py-sm text-on-surface-variant">{s.contact_email || '—'}</td>
                  <td className="px-lg py-sm text-on-surface-variant">
                    {s.bank && hasBanking(s.bank)
                      ? <span title="Open the vendor for the full details">{s.bank.bankName || 'Bank'}{s.bank.accountNumber ? <span className="font-mono"> {maskAccount(s.bank.accountNumber)}</span> : ''}{s.bank.branchCode ? <span className="font-mono text-outline"> · {s.bank.branchCode}</span> : ''}</span>
                      : <span className="text-outline">Not set</span>}
                    {s.bankUpdatedAt && Date.now() - new Date(s.bankUpdatedAt).getTime() < 30 * 86_400_000 && (
                      <span className="ml-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-amber-500/10 text-amber-500" title="Changed in the last 30 days: confirm by phone before paying">changed recently</span>
                    )}
                  </td>
                  <td className="px-lg py-sm text-right font-mono">{s.leadTime ? `${s.leadTime}d` : '—'}</td>
                  <td className="px-lg py-sm text-right font-mono font-bold">{(balances.get(s.id) || 0) > 0 ? fmtMoney(balances.get(s.id)) : '—'}</td>
                </tr>
              ))}
              {suppliers.length === 0 && <EmptyState message="No suppliers yet — add one from the Suppliers page." colSpan={6} />}
            </tbody>
          </table>
        </div>
      </SectionCard>

      {viewing && (
        <Vendor360Modal
          vendor={viewing}
          purchaseOrders={purchaseOrders}
          bills={bills}
          paymentsMade={paymentsMade}
          expenses={expenses}
          onClose={() => setViewing(null)}
        />
      )}
    </>
  );
};
