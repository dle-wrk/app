import React from 'react';
import { Search } from 'lucide-react';
import { Item, Transaction, Supplier } from '../../types';

interface SearchViewProps {
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  filteredItems: Item[];
  filteredTrx: Transaction[];
  filteredSuppliers: Supplier[];
  setShowAddModal: (show: boolean) => void;
}

export const SearchView: React.FC<SearchViewProps> = ({
  searchQuery,
  setSearchQuery,
  filteredItems,
  filteredTrx,
  filteredSuppliers,
  setShowAddModal
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Search Results Dashboard */}
      <div className="flex justify-between items-end mb-lg">
        <div>
          <h3 className="font-headline-sm text-lg text-on-surface">Search Results</h3>
          <p className="text-on-surface-variant font-body-sm">
            Found {filteredItems.length} items, {filteredTrx.length} transactions, and {filteredSuppliers.length} suppliers matching "{searchQuery}"
          </p>
        </div>
        <button
          onClick={() => setSearchQuery('')}
          className="text-primary text-xs font-bold hover:underline"
        >
          Clear Search
        </button>
      </div>

      {/* Zero State */}
      {filteredItems.length === 0 && filteredTrx.length === 0 && filteredSuppliers.length === 0 && (
        <div className="flex flex-col items-center justify-center p-xl bg-surface-container border border-outline-variant rounded-xl text-center">
          <div className="w-16 h-16 mb-md rounded-full bg-surface-container-high flex items-center justify-center border border-outline-variant text-outline">
            <Search className="w-8 h-8" />
          </div>
          <h2 className="font-headline-md text-red-400 mb-xs">No Results for "{searchQuery}"</h2>
          <p className="text-on-surface-variant max-w-[384px] mb-md text-sm">
            We couldn't find any items, transactions, or suppliers matching your query. Check for typos or try broader keywords.
          </p>
          <button
            onClick={() => setShowAddModal(true)}
            className="bg-primary text-on-primary font-bold px-md py-2 rounded"
          >
            Create Class Item
          </button>
        </div>
      )}

      {/* Matching Items */}
      {filteredItems.length > 0 && (
        <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden">
          <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
            <span className="font-bold text-sm">Matching Inventory Items ({filteredItems.length})</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-surface-container-high/50 font-label-caps text-[10px] text-outline border-b border-outline-variant">
                  <th className="px-lg py-sm">Part Number</th>
                  <th className="px-lg py-sm">Description</th>
                  <th className="px-lg py-sm">Category</th>
                  <th className="px-lg py-sm text-right">Stock Level</th>
                  <th className="px-lg py-sm text-right">Price</th>
                  <th className="px-lg py-sm">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 text-sm">
                {filteredItems.map(item => (
                  <tr key={item.partNumber} className="hover:bg-surface-variant/20">
                    <td className="px-lg py-sm font-mono text-xs text-primary font-bold">{item.partNumber}</td>
                    <td className="px-lg py-sm font-semibold">{item.name} <span className="text-[10px] font-normal text-on-surface-variant block">{item.description}</span></td>
                    <td className="px-lg py-sm font-mono text-xs text-on-surface-variant">{item.category}</td>
                    <td className="px-lg py-sm font-mono text-xs text-right text-on-surface font-black">{(item.stockLevel ?? 0).toLocaleString()}</td>
                    <td className="px-lg py-sm font-mono text-xs text-right text-green-400">${(Number(item.price ?? 0)).toFixed(2)}</td>
                    <td className="px-lg py-sm">
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-bold border ${item.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                        item.status === 'INACTIVE' ? 'bg-red-500/10 text-red-500 border-red-500/20' :
                          item.status === 'BOOKED OUT' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' :
                            'bg-surface-container-highest text-outline border-outline-variant'
                        }`}>{item.status}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};