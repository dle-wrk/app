import React from 'react';
import { canChange } from '../../lib/changeAccess';
import { Plus, ExternalLink, Shield, Clock, Trash2 } from 'lucide-react';
import { Supplier } from '../../types';

interface SuppliersViewProps {
  suppliers: Supplier[];
  setEditingSupplier: (supplier: Supplier | null) => void;
  setShowSupplierModal: (show: boolean) => void;
  onDeleteSupplier?: (supplier: Supplier) => Promise<void>;
}

export const SuppliersView: React.FC<SuppliersViewProps> = ({
  suppliers,
  setEditingSupplier,
  setShowSupplierModal,
  onDeleteSupplier,
}) => {
  // Sort by ID (sequential order)
  const sortedSuppliers = [...suppliers].sort((a, b) => {
    return parseInt(a.id) - parseInt(b.id);
  });

  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Header view suppliers directory info */}
      <div className="flex flex-col md:flex-row md:justify-between md:items-end gap-md mb-lg">
        <div className="min-w-0">
          <h3 className="font-headline-sm text-lg text-on-surface">Registered Procurement Partners</h3>
          <p className="text-on-surface-variant font-body-sm">
            Configure external vendor connections, compliance directories, and contact parameters.
          </p>
        </div>
        {canChange('/api/suppliers') && <button
          onClick={() => {
            setEditingSupplier(null);
            setShowSupplierModal(true);
          }}
          className="bg-primary text-white px-3 py-1.5 rounded-lg font-bold text-xs shadow-md shadow-primary/10 hover:brightness-110 active:scale-95 transition-all duration-150 flex items-center gap-1.5 self-start md:self-auto"
        >
          <Plus className="w-3.5 h-3.5" />
          Add Supplier
        </button>}
      </div>

      {/* Table containing the mock suppliers directories list */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-md">
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-surface-container-high/50 font-label-caps text-[10px] text-outline border-b border-outline-variant">
                <th className="px-lg py-sm">Supplier Entity</th>
                <th className="px-lg py-sm">Website</th>
                <th className="px-lg py-sm text-center">Avg Lead Time</th>
                <th className="px-lg py-sm text-center">Avg Response</th>
                <th className="px-lg py-sm">Contact Email</th>
                <th className="px-lg py-sm">Notes</th>
                <th className="px-lg py-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs text-on-surface">
              {sortedSuppliers.map(s => (
                <tr key={s.id} className="hover:bg-surface-variant/20 transition-all duration-150">
                  <td className="px-lg py-sm font-bold text-sm">
                    {s.name}
                    <span className="text-[10px] text-outline block font-normal">ID: {s.id}</span>
                  </td>
                  <td className="px-lg py-sm font-mono text-primary">
                    <a href={s.website} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-1">
                      {s.website} <ExternalLink className="w-3 h-3" />
                    </a>
                  </td>
                  <td className="px-lg py-sm text-center">
                    {(() => {
                      // Measured from received purchase orders where there are any, else as typed.
                      const measured = s.measuredLeadTime != null;
                      const days = measured ? s.measuredLeadTime! : s.leadTime;
                      if (days == null) return <span className="text-outline">Not set</span>;
                      return (
                        <span className="inline-flex flex-col items-center gap-0.5" data-testid={`lead-${s.id}`}>
                          <span className={`px-2 py-1 rounded-md font-bold font-mono ${
                            days <= 7 ? 'text-green-400 bg-green-500/10' : days <= 14 ? 'text-yellow-400 bg-yellow-500/10' : 'text-red-400 bg-red-500/10'
                          }`}>{days} {days === 1 ? 'Day' : 'Days'}</span>
                          <span className="text-[10px] text-outline" title={measured ? `Median days from order to received over ${s.measuredOrders} received purchase order(s); slowest ${s.measuredSlowest} days.` : 'Typed on the supplier: no received purchase orders to measure yet.'}>
                            {measured ? `measured · ${s.measuredOrders} order${s.measuredOrders === 1 ? '' : 's'}${s.leadTime != null && s.leadTime !== days ? ` (typed ${s.leadTime})` : ''}` : 'typed'}
                          </span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-lg py-sm text-center">
                    <span className={`px-2 py-1 rounded-md font-bold font-mono ${
                      (s.responseTime || 0) <= 4 ? 'text-green-400 bg-green-500/10' :
                      (s.responseTime || 0) <= 24 ? 'text-yellow-400 bg-yellow-500/10' :
                      'text-red-400 bg-red-500/10'
                    }`}>
                      {s.responseTime != null ? `${s.responseTime} Hrs` : 'N/A'}
                    </span>
                  </td>
                  <td className="px-lg py-sm font-mono">
                    {s.contact_email || 'N/A'}
                  </td>
                  <td className="px-lg py-sm italic text-on-surface-variant">
                    {s.notes}
                  </td>
                  <td className="px-lg py-sm text-right">
                    <div className="flex justify-end gap-1">
                      {canChange('/api/suppliers', 'PUT') && <button
                        onClick={() => {
                          setEditingSupplier(s);
                          setShowSupplierModal(true);
                        }}
                        className="text-primary hover:text-primary/80 font-bold p-1 hover:bg-primary/10 rounded transition-all"
                      >
                        Edit
                      </button>}
                      {onDeleteSupplier && canChange('/api/suppliers/1', 'DELETE') && (
                        <button
                          onClick={() => onDeleteSupplier(s)}
                          className="text-error hover:text-error/80 p-1 hover:bg-error/10 rounded transition-all"
                          title="Delete supplier"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* How the lead times are worked out */}
      <div className="bg-surface-container p-md border border-outline-variant rounded-xl flex items-start gap-md mt-lg">
        <div className="bg-tertiary/10 p-sm rounded text-tertiary shrink-0 self-center">
          <Clock className="w-6 h-6" />
        </div>
        <div>
          <h5 className="font-bold text-xs mb-1">Lead times</h5>
          <p className="text-on-surface-variant text-[11px] leading-relaxed">
            Measured where a supplier has received purchase orders: the median days from the order date to the day the PO was marked
            Received (recorded from 21 Oct 2026; a bill's date isn't used, as bills are often entered when the order is placed). Until then,
            the lead time typed on the supplier is shown. Restock suggestions use each item's supplier's lead time: its Supplier field,
            else the slowest of the suppliers it has part numbers for.
          </p>
        </div>
      </div>
    </div>
  );
};