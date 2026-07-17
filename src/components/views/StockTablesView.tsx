import React from 'react';
import { Database, Plus, Download, Edit3 } from 'lucide-react';
import { ProductionKit, Project } from '../../types';

interface StockTablesViewProps {
  setIsKitModalOpen: (open: boolean) => void;
  selectedTableTab: 'Production_Kits' | 'users' | 'Item_Pricing';
  setSelectedTableTab: (tab: 'Production_Kits' | 'users' | 'Item_Pricing') => void;
  handleExportCSV: (name: string) => void;
  productionKits: ProductionKit[];
  projects: Project[];
  onEditKit: (kit: ProductionKit) => void;
}

export const StockTablesView: React.FC<StockTablesViewProps> = ({
  setIsKitModalOpen,
  selectedTableTab,
  setSelectedTableTab,
  handleExportCSV,
  productionKits,
  projects,
  onEditKit
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-7xl mx-auto w-full">
      {/* Database tables selector header section */}
      <div className="grid grid-cols-12 gap-4 items-center">
        <div className="col-span-12 md:col-span-6">
          <div className="bg-primary-container/10 border border-primary/20 text-primary px-3 py-1.5 rounded-full inline-flex items-center gap-2 text-xs font-mono">
            <Database className="w-3.5 h-3.5" />
            <span>DB: Neon Postgres (Connected)</span>
          </div>
          <p className="text-on-surface-variant/80 text-xs mt-1.5">
            Direct view on transactional systems tables and entity parameters.
          </p>
        </div>
        <div className="col-span-12 md:col-span-6 flex justify-end">
          <button
            onClick={() => setIsKitModalOpen(true)}
            className="bg-primary text-white px-4 py-2 rounded-lg font-bold text-xs shadow-md shadow-primary/10 hover:brightness-110 active:scale-95 transition-all flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            Provision New Kit
          </button>
        </div>
      </div>

      {/* High Density Selection cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 select-none mt-5">
        {/* Users */}
        <div
          onClick={() => setSelectedTableTab('users')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 ${selectedTableTab === 'users'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>users</span>
            <span className="font-bold">4,209 Rows</span>
          </div>
          <h5 className="font-bold text-sm text-on-surface">users_ledger</h5>
          <p className="text-[11px] text-on-surface-variant/80">System access and security tokens.</p>
        </div>

        {/* Production kits */}
        <div
          onClick={() => setSelectedTableTab('Production_Kits')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 relative ${selectedTableTab === 'Production_Kits'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <span className="absolute top-2 right-2 bg-primary text-on-primary text-[8px] font-bold px-1.5 py-0.5 rounded-full uppercase tracking-wider">
            active
          </span>
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>Production_Kits</span>
            <span className="font-bold">1,120 Rows</span>
          </div>
          <h5 className={`font-bold text-sm ${selectedTableTab === 'Production_Kits' ? 'text-primary' : 'text-on-surface'}`}>
            Production_Kits
          </h5>
          <p className="text-[11px] text-on-surface-variant/80">BOM mapping and hardware logs.</p>
        </div>

        {/* Item pricing */}
        <div
          onClick={() => setSelectedTableTab('Item_Pricing')}
          className={`p-4 rounded-xl border flex flex-col gap-2.5 cursor-pointer transition-all duration-150 ${selectedTableTab === 'Item_Pricing'
            ? 'border-primary bg-primary/5 shadow-md'
            : 'border-outline-variant bg-surface-container hover:border-primary/40'
            }`}
        >
          <div className="flex justify-between items-center text-on-surface-variant/70 text-[11px] font-mono">
            <span>Item_Pricing</span>
            <span className="font-bold">12,850 Rows</span>
          </div>
          <h5 className="font-bold text-sm text-on-surface">Item_Pricing</h5>
          <p className="text-[11px] text-on-surface-variant/80">Standard vendor rates directory.</p>
        </div>
      </div>

      {/* Raw Database display Table */}
      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl mt-4">
        <div className="px-4 py-3 border-b border-outline-variant bg-surface-container-high/40 flex justify-between items-center">
          <span className="font-mono text-xs uppercase tracking-wider font-black text-on-surface-variant">
            VIEWING TABLE: {selectedTableTab.toUpperCase()}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => handleExportCSV(selectedTableTab)}
              className="bg-surface-container-high text-on-surface-variant border border-outline-variant p-1.5 rounded-lg hover:bg-surface-container-highest hover:text-on-surface transition-colors"
            >
              <Download className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {selectedTableTab === 'Production_Kits' ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse min-w-[900px]">
              <thead>
                <tr className="bg-surface-container-high/30 text-[10px] uppercase font-mono text-on-surface-variant/80 tracking-wider border-b border-outline-variant">
                  <th className="px-4 py-3">Kit ID</th>
                  <th className="px-4 py-3">SKU Reference</th>
                  <th className="px-4 py-3">Associated Project</th>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3 text-right">Available qty</th>
                  <th className="px-4 py-3">Assembly Line</th>
                  <th className="px-4 py-3 text-right">Last Updated</th>
                  <th className="px-4 py-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant/30 text-xs font-mono">
                {productionKits.map(kit => {
                  const project = projects.find(p => p.id === kit.projectId);
                  return (
                    <tr key={kit.kitId} className="hover:bg-surface-variant/10 transition-colors">
                      <td className="px-4 py-3 text-primary font-bold">{kit.kitId}</td>
                      <td className="px-4 py-3 text-on-surface-variant">{kit.skuReference}</td>
                      <td className="px-4 py-3">
                        {project ? (
                          <span className="text-on-surface font-semibold">{project.projectName}</span>
                        ) : (
                          <span className="text-on-surface-variant/50 italic">None</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold border ${kit.status === 'READY' ? 'bg-green-500/10 text-green-400 border-green-500/20' :
                          kit.status === 'STAGING' ? 'bg-yellow-500/10 text-yellow-500 border-yellow-500/20' :
                            kit.status === 'BLOCKED' ? 'bg-red-500/10 text-red-400 border-red-500/20' :
                              'bg-blue-500/10 text-blue-400 border-blue-500/20'
                          }`}>{kit.status}</span>
                      </td>
                      <td className="px-4 py-3 text-right text-on-surface font-semibold">{(kit.qtyAvailable ?? 0).toLocaleString()}</td>
                      <td className="px-4 py-3 text-on-surface">{kit.assemblyLine}</td>
                      <td className="px-4 py-3 text-on-surface-variant/70 text-right">{kit.lastUpdated}</td>
                      <td className="px-4 py-3 text-center">
                        <button
                          onClick={() => onEditKit(kit)}
                          className="p-1.5 text-primary hover:bg-primary/10 rounded-lg transition-colors"
                          title="Edit Kit"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="p-8 text-center text-xs text-on-surface-variant/80 font-mono">
            Database table <span className="text-secondary font-bold">"{selectedTableTab}"</span> is loaded from SQLite. Total rows tracked in backend.
          </div>
        )}
      </div>
    </div>
  );
};