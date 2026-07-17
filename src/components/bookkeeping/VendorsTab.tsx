import React, { useMemo } from 'react';
import { ExternalLink } from 'lucide-react';
import { ModuleDataProps, fmtMoney, EmptyState, SectionCard } from './shared';

export const VendorsTab: React.FC<ModuleDataProps> = ({ suppliers, bills }) => {
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
    <SectionCard
      title="Vendors"
      badge={`${suppliers.length} suppliers`}
      actions={<span className="text-[10px] text-outline">Full contact management lives in the Suppliers page</span>}
    >
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead>
            <tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant">
              <th className="px-lg py-sm">ID</th>
              <th className="px-lg py-sm">Name</th>
              <th className="px-lg py-sm">Contact</th>
              <th className="px-lg py-sm text-right">Lead Time</th>
              <th className="px-lg py-sm text-right">AP Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-outline-variant/30">
            {suppliers.map(s => (
              <tr key={s.id} className="hover:bg-surface-variant/20 transition-all">
                <td className="px-lg py-sm font-mono text-outline">{s.id}</td>
                <td className="px-lg py-sm font-bold">
                  {s.name}
                  {s.website && <a href={s.website} target="_blank" rel="noreferrer" className="inline-block ml-1.5 text-primary align-middle"><ExternalLink className="w-3 h-3 inline" /></a>}
                </td>
                <td className="px-lg py-sm text-on-surface-variant">{s.contact_email || '—'}</td>
                <td className="px-lg py-sm text-right font-mono">{s.leadTime ? `${s.leadTime}d` : '—'}</td>
                <td className="px-lg py-sm text-right font-mono font-bold">{(balances.get(s.id) || 0) > 0 ? fmtMoney(balances.get(s.id)) : '—'}</td>
              </tr>
            ))}
            {suppliers.length === 0 && <EmptyState message="No suppliers yet — add one from the Suppliers page." colSpan={5} />}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
};
