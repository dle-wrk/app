import React, { useState } from 'react';
import { PickPlaceItem, Project } from '../types';
import { 
  Lock, 
  Download, 
  Layers, 
  MapPin, 
  FileSpreadsheet, 
  Check, 
  Cpu, 
  Printer, 
  Sparkles,
  Search,
  HardDrive
} from 'lucide-react';

interface PickPlaceManagerProps {
  projects: Project[];
  ppItems: PickPlaceItem[];
  triggerToast: (msg: string) => void;
  onItemClick?: (partNumber: string) => void;
}

export default function PickPlaceManager({
  projects,
  ppItems,
  triggerToast,
  onItemClick
}: PickPlaceManagerProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(1); // Default to project 1

  React.useEffect(() => {
    if (projects.length > 0 && !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects]);
  const [searchQuery, setSearchQuery] = useState<string>('');

  // SMT Assembly specs for the chosen project layout
  const filteredBoms = ppItems.filter(
    item => item.projectId === selectedProjectId &&
    (item.stockCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
     item.designator.toLowerCase().includes(searchQuery.toLowerCase()) ||
     item.footprint.toLowerCase().includes(searchQuery.toLowerCase()) ||
     item.comment.toLowerCase().includes(searchQuery.toLowerCase()) ||
     item.description.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  const activeProject = projects.find(p => p.id === selectedProjectId);

  // Stats counting helpers
  const totalPlacementsCount = filteredBoms.reduce((acc, curr) => acc + curr.quantity, 0);
  const totalUniqueRows = filteredBoms.length;

  const handleExportCADManifest = () => {
    triggerToast(`Exported SMT CPL Pick & Place CSV file for Project ${selectedProjectId} PCB Assembly.`);
  };

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      
      {/* Title Header with locked state indicators */}
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md relative overflow-hidden">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-orange-400">
            <Lock className="w-4 h-4" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">LOCKED DIRECTORY (SMT MANUFACTURING)</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Pick & Place Placement Directory (PP_BOM)</h3>
          <p className="text-on-surface-variant text-xs max-w-[576px]">
            Read-only verified CAD coordinate feeds. These manifests are locked for pick & place machines and cannot be edited. Export the CPL and BOM files directly.
          </p>
        </div>

        {/* Dynamic Project Layout selection tabs */}
        <div className="flex items-center gap-sm shrink-0 bg-surface-container-high/60 border border-outline-variant p-1.5 rounded-lg">
          <span className="text-[10px] text-outline font-black uppercase tracking-wider ml-xs">Target Board:</span>
          <select
            className="bg-surface-container-high border border-outline-variant rounded px-sm py-1 text-xs font-bold text-on-surface outline-none focus:border-primary min-w-[160px]"
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(Number(e.target.value))}
          >
            {projects.map(p => (
              <option key={p.id} value={p.id}>{p.projectName}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Main CAD positions layout body */}
      <div className="grid grid-cols-12 gap-lg items-start">
        
        {/* Left Side: Layout constraints summary */}
        <div className="col-span-12 lg:col-span-4 space-y-lg">
          
          {/* Target specifications read-only metrics */}
          <div className="bg-surface-container p-lg rounded-xl border border-outline-variant space-y-md relative overflow-hidden">
            <div className="absolute top-2 right-2 flex items-center bg-orange-400/10 border border-orange-400/20 text-orange-400 text-[8px] font-mono leading-none tracking-widest uppercase font-extrabold px-1.5 py-0.5 rounded">
              Read-Only Source
            </div>
            
            <h4 className="font-bold text-sm text-primary flex items-center gap-xs">
              <Cpu className="w-4 h-4 text-primary" />
              SMT Assembly Specifications
            </h4>

            <div className="space-y-sm text-xs border-y border-outline-variant/30 py-sm">
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Designators Sheet:</span>
                <span className="font-mono font-bold text-on-surface">PP_BOM_REV_{selectedProjectId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-on-surface-variant">Active Layout:</span>
                <span className="font-semibold text-on-surface">{activeProject?.projectName}</span>
              </div>
              <span className="text-[11px] block mt-1 leading-relaxed text-on-surface-variant italic">
                "{activeProject?.description}"
              </span>
            </div>

            <div className="grid grid-cols-2 gap-sm">
              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60">
                <span className="text-[9px] text-outline font-label-caps uppercase block leading-none mb-1">Unique Feeders</span>
                <span className="text-lg font-black font-mono leading-none text-primary">
                  {totalUniqueRows}
                </span>
              </div>
              <div className="bg-surface-container-high/40 p-sm rounded-lg border border-outline-variant/60">
                <span className="text-[9px] text-outline font-label-caps uppercase block leading-none mb-1">Total Placements</span>
                <span className="text-lg font-black font-mono leading-none text-secondary">
                  {totalPlacementsCount}
                </span>
              </div>
            </div>

            {/* Locked warning description block */}
            <div className="p-sm bg-orange-500/10 text-orange-400 font-mono text-[11px] rounded-lg border border-orange-500/15 flex gap-2">
              <Lock className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                <span className="font-bold uppercase block mb-1">LOCKED CAD TEMPLATE</span>
                Pick and place data represents the static copper stencil coordinates designed by external engineers. It cannot be altered locally to maintain trace alignment.
              </div>
            </div>

            <button
              onClick={handleExportCADManifest}
              className="mt-lg w-full bg-primary hover:brightness-110 active:scale-95 text-on-primary py-2.5 rounded-lg font-bold text-xs shadow flex items-center justify-center gap-xs uppercase tracking-wider transition-all duration-150"
            >
              <Download className="w-3.5 h-3.5" />
              Export SMT Manifest (CPL)
            </button>
          </div>

          {/* SMT Feeder optimization chart */}
          <div className="bg-surface-container p-lg border border-outline-variant rounded-xl space-y-sm">
            <h5 className="font-bold text-xs uppercase tracking-wider text-outline font-label-caps">
              Feeder Setup Audit
            </h5>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              Calculates structural reel allocation metrics for physical pick and place loaders on demans lines.
            </p>
            <div className="space-y-sm text-xs font-mono pt-sm">
              <div className="flex justify-between items-center text-[10px]">
                <span className="text-on-surface-variant">0603 Tape Feeders (12mm)</span>
                <span className="font-bold text-primary">12 Reels</span>
              </div>
              <div className="w-full bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
                <div className="bg-primary h-full w-[65%]"></div>
              </div>

              <div className="flex justify-between items-center text-[10px]">
                <span className="text-on-surface-variant">SOIC & QFP Tray Feeders</span>
                <span className="font-bold text-secondary">4 Trays</span>
              </div>
              <div className="w-full bg-outline-variant/30 h-1.5 rounded-full overflow-hidden">
                <div className="bg-secondary h-full w-[25%]"></div>
              </div>
            </div>
          </div>
        </div>

        {/* Right Side: CAD Placements listing table */}
        <div className="col-span-12 lg:col-span-8 space-y-md">
          <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
            <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex flex-col sm:flex-row justify-between sm:items-center gap-sm">
              <span className="font-mono text-xs uppercase tracking-tight font-black text-on-surface-variant flex items-center gap-1.5">
                <HardDrive className="w-4 h-4 text-primary" />
                VERIFIED PICK & PLACE PLACEMENT LIST
              </span>
              
              {/* Quick search input */}
              <div className="flex items-center bg-surface-container-high rounded px-sm py-1 border border-outline-variant w-full sm:w-64 font-mono text-xs">
                <Search className="text-outline w-3.5 h-3.5 mr-xs shrink-0" />
                <input 
                  className="bg-transparent border-none focus:outline-none focus:ring-0 text-[11px] w-full text-on-surface" 
                  placeholder="Filter stock, designator, note..."
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse min-w-[700px]">
                <thead>
                  <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                    <th className="px-lg py-sm">Stock Code</th>
                    <th className="px-lg py-sm">Placement Note & Library</th>
                    <th className="px-lg py-sm">Ref Designators</th>
                    <th className="px-lg py-sm">CAD Footprint</th>
                    <th className="px-lg py-sm text-right">Qty</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant/30 text-xs font-mono">
                  {filteredBoms.length > 0 ? (
                    filteredBoms.map(item => (
                      <tr key={item.id} className="hover:bg-surface-variant/20 transition-all duration-150">
                        <td className="px-lg py-sm">
                          <span 
                            onClick={() => onItemClick?.(item.stockCode)}
                            className="text-primary font-bold hover:underline cursor-pointer select-none"
                            title="Click to view/edit component details"
                          >
                            {item.stockCode}
                          </span>
                        </td>
                        <td className="px-lg py-sm">
                          <span className="text-on-surface font-bold block">{item.comment}</span>
                          <span className="text-[10px] text-outline block italic mb-1">{item.description}</span>
                          <span className="text-[10px] text-outline block">{item.libref}</span>
                        </td>
                        <td className="px-lg py-sm text-on-surface max-w-[150px] truncate" title={item.designator}>
                          {item.designator}
                        </td>
                        <td className="px-lg py-sm text-outline">{item.footprint}</td>
                        <td className="px-lg py-sm text-right text-on-surface font-semibold">{item.quantity}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="p-lg text-center text-on-surface-variant text-xs">
                        No CAD placements matching your filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
}
