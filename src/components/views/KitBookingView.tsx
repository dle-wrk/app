import React, { useState, useEffect } from 'react';
import { Project } from '../../types';
import ShortageToPOModal from '../ShortageToPOModal';
import {
  Package,
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  Play,
  Loader2,
  Layers,
  ArrowRightLeft,
  ShoppingCart
} from 'lucide-react';

interface AuditResult {
  component_id: string;
  resolved_part_number: string;
  used_alternative: boolean;
  qty_required: number;
  qty_on_hand: number;
  shortage_qty: number;
  description: string;
  comment: string;
  designator?: string;
  supplier_links: string[];
}

interface KitBookingViewProps {
  projects: Project[];
  triggerToast: (msg: string) => void;
}

export default function KitBookingView({ projects, triggerToast }: KitBookingViewProps) {
  const [selectedProjectId, setSelectedProjectId] = useState<number>(projects[0]?.id || 1);
  const [buildQty, setBuildQty] = useState<number>(1);
  const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [showShortagePOModal, setShowShortagePOModal] = useState(false);
  const [showConfirmBooking, setShowConfirmBooking] = useState(false);

  useEffect(() => {
    if (projects.length > 0 && !projects.find(p => p.id === selectedProjectId)) {
      setSelectedProjectId(projects[0].id);
    }
  }, [projects]);

  useEffect(() => {
    handleValidate();
  }, [selectedProjectId, buildQty]);

  const handleValidate = async () => {
    if (!selectedProjectId || buildQty <= 0) return;
    setLoading(true);
    try {
      const res = await fetch('/api/kit-booking/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId, buildQty })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAuditResults(data);
    } catch (err: any) {
      triggerToast(`Validation failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  const handleExecute = async () => {
    setShowConfirmBooking(false);
    setExecuting(true);
    try {
      const res = await fetch('/api/kit-booking/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: selectedProjectId, buildQty })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      triggerToast('Booking processed successfully!');
      handleValidate(); // Refresh stock
    } catch (err: any) {
      triggerToast(`Booking failed: ${err.message}`);
    } finally {
      setExecuting(false);
    }
  };

  const totalShortages = auditResults.filter(r => r.shortage_qty > 0).length;

  return (
    <div className="p-container-margin space-y-lg max-w-[1600px] mx-auto w-full select-none">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl flex flex-wrap lg:items-center justify-between gap-md relative overflow-hidden">
        <div className="space-y-1 flex-1 min-w-[300px]">
          <div className="flex items-center gap-xs text-primary">
            <Package className="w-5 h-5" />
            <span className="font-label-caps text-[10px] uppercase font-bold tracking-wider">Production Logistics</span>
          </div>
          <h3 className="font-headline-sm text-lg font-black text-on-surface">Pick & Place (P&P) Kit Booking</h3>
          <p className="text-on-surface-variant text-xs max-w-[576px]">
            Audit inventory against BOM for production runs. Automatically resolves alternatives and identifies shortages.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-md">
          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-outline font-black uppercase tracking-wider">Project</label>
            <select
              className="bg-surface-container-high border border-outline-variant rounded px-sm py-1.5 text-xs font-bold text-on-surface outline-none focus:border-primary min-w-[200px]"
              value={selectedProjectId}
              onChange={(e) => setSelectedProjectId(Number(e.target.value))}
            >
              {projects.map(p => (
                <option key={p.id} value={p.id}>{p.projectName}</option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-[10px] text-outline font-black uppercase tracking-wider">Build Quantity</label>
            <input
              type="number"
              min="1"
              className="bg-surface-container-high border border-outline-variant rounded px-sm py-1.5 text-xs font-bold text-on-surface outline-none focus:border-primary w-[80px] text-center"
              value={buildQty}
              onChange={(e) => setBuildQty(Math.max(1, Number(e.target.value)))}
            />
          </div>

          {totalShortages > 0 && (
            <button
              onClick={() => setShowShortagePOModal(true)}
              className="mt-auto h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all bg-error/10 text-error hover:bg-error/20 active:scale-95 border border-error/20"
            >
              <ShoppingCart className="w-3.5 h-3.5" />
              Generate PO
            </button>
          )}

          <button
            onClick={() => setShowConfirmBooking(true)}
            disabled={totalShortages > 0 || loading || executing || auditResults.length === 0}
            title={totalShortages > 0 ? `Booking blocked: ${totalShortages} component shortage(s). Resolve shortages or generate a PO first.` : auditResults.length === 0 ? 'No BOM data for this project.' : undefined}
            className={`mt-auto h-9 px-lg rounded-lg flex items-center gap-xs text-xs font-bold uppercase tracking-wider transition-all ${
              totalShortages > 0 || auditResults.length === 0
                ? 'bg-surface-container-highest text-outline cursor-not-allowed border border-outline-variant'
                : 'bg-primary text-on-primary hover:brightness-110 active:scale-95'
            }`}
          >
            {executing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            {executing ? 'Processing...' : 'Process Booking'}
          </button>
        </div>
      </div>

      <div className="bg-surface-container rounded-xl border border-outline-variant overflow-hidden shadow-xl">
        <div className="px-lg py-sm border-b border-outline-variant bg-surface-container-high/30 flex justify-between items-center text-xs">
          <span className="font-mono text-xs uppercase tracking-tight font-black text-on-surface-variant flex items-center gap-1.5">
            <Layers className="w-4 h-4 text-primary" />
            Live Inventory Audit
          </span>
          {loading && <Loader2 className="w-3.5 h-3.5 animate-spin text-primary" />}
        </div>

        <div className="overflow-x-auto">
          <table className="stacked-mobile w-full text-left border-collapse min-w-[1000px]">
            <thead>
              <tr className="bg-surface-container-high text-[10px] uppercase font-mono text-outline border-b border-outline-variant">
                <th className="px-lg py-2">Component ID</th>
                <th className="px-lg py-2">Description / Comment</th>
                <th className="px-lg py-2 text-right">Required</th>
                <th className="px-lg py-2 text-right">On Hand</th>
                <th className="px-lg py-2 text-center">Status</th>
                <th className="px-lg py-2 text-center">Alternatives</th>
                <th className="px-lg py-2">Sourcing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant/30 text-xs">
              {auditResults.map((res) => (
                <tr key={res.component_id} className={`hover:bg-surface-variant/20 transition-all ${res.shortage_qty > 0 ? 'bg-red-500/5' : ''}`}>
                  <td className="px-lg py-3" data-label="Part">
                    <div className="font-mono font-bold text-primary">{res.component_id}</div>
                    {res.designator && (
                      <div className="text-[9px] text-outline font-mono truncate max-w-[150px]" title={res.designator}>
                        {res.designator}
                      </div>
                    )}
                  </td>
                  <td className="px-lg py-3" data-label="Description">
                    <div className="max-w-[300px] truncate font-medium text-on-surface">{res.description}</div>
                    <div className="text-[10px] text-outline italic">{res.comment}</div>
                  </td>
                  <td className="px-lg py-3 text-right font-mono font-bold" data-label="Required">
                    {res.qty_required}
                  </td>
                  <td className="px-lg py-3 text-right font-mono" data-label="On hand">
                    <span className={res.qty_on_hand < res.qty_required ? 'text-red-400 font-bold' : 'text-on-surface'}>
                      {res.qty_on_hand}
                    </span>
                  </td>
                  <td className="px-lg py-3 text-center" data-label="Status">
                    {res.shortage_qty > 0 ? (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-red-500/10 text-red-400 border border-red-500/15 font-mono uppercase">
                        <AlertTriangle className="w-3 h-3" />
                        Short: {res.shortage_qty}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-bold bg-green-500/10 text-green-400 border border-green-500/15 font-mono uppercase">
                        <CheckCircle2 className="w-3 h-3" />
                        Ready
                      </span>
                    )}
                  </td>
                  <td className="px-lg py-3 text-center" data-label="Alternates">
                    {res.used_alternative ? (
                      <div className="flex flex-col items-center">
                        <span className="inline-flex items-center gap-1 text-[9px] font-bold text-primary font-mono uppercase bg-primary/10 border border-primary/20 px-1 py-0.5 rounded">
                          <ArrowRightLeft className="w-2.5 h-2.5" />
                          Subbed
                        </span>
                        <span className="text-[8px] text-outline font-mono mt-1">{res.resolved_part_number}</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-outline italic">None used</span>
                    )}
                  </td>
                  <td className="px-lg py-3" data-label="Sourcing">
                    {(() => {
                      const validLinks = (res.supplier_links || [])
                        .map(v => typeof v === 'string' ? v.trim() : '')
                        .filter(v => /^https?:\/\/\S+\.\S+/.test(v))
                        .slice(0, 3);
                      if (validLinks.length === 0) {
                        return <span className="text-[10px] text-outline italic">No links</span>;
                      }
                      return (
                        <div className="flex gap-1.5">
                          {validLinks.map((link, idx) => {
                            let host = '';
                            try { host = new URL(link).hostname.replace(/^www\./, ''); } catch { /* leave blank */ }
                            return (
                              <a
                                key={idx}
                                href={link}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={host || link}
                                className="p-1 rounded bg-surface-container-highest border border-outline-variant hover:border-primary transition-colors text-outline hover:text-primary"
                              >
                                <ExternalLink className="w-3 h-3" />
                              </a>
                            );
                          })}
                        </div>
                      );
                    })()}
                  </td>
                </tr>
              ))}
              {auditResults.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="px-lg py-12 text-center text-outline italic font-mono">
                    No BOM data found for the selected project.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showConfirmBooking && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowConfirmBooking(false)}>
          {/* Explicit width: max-w-md would resolve to --spacing-md (16px) here. */}
          <div className="bg-surface-container border border-outline-variant rounded-xl shadow-2xl max-w-[448px] w-full mx-4" onClick={(e) => e.stopPropagation()}>
            <div className="px-lg py-md border-b border-outline-variant flex items-center gap-xs">
              <Play className="w-4 h-4 text-primary" />
              <h4 className="font-bold text-sm text-on-surface">Confirm Kit Booking</h4>
            </div>
            <div className="px-lg py-md text-xs text-on-surface-variant space-y-1">
              <p>
                Book out parts for <span className="font-bold text-on-surface">{buildQty} unit{buildQty === 1 ? '' : 's'}</span> of{' '}
                <span className="font-bold text-primary">{projects.find(p => p.id === selectedProjectId)?.projectName || 'selected project'}</span>?
              </p>
              <p>This will deduct stock for {auditResults.length} component line{auditResults.length === 1 ? '' : 's'} and log the transactions.</p>
            </div>
            <div className="px-lg py-md border-t border-outline-variant flex justify-end gap-sm">
              <button
                onClick={() => setShowConfirmBooking(false)}
                className="px-md py-1.5 rounded-lg text-xs font-bold border border-outline-variant text-on-surface hover:bg-surface-variant/40 transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleExecute}
                className="px-md py-1.5 rounded-lg text-xs font-bold bg-primary text-on-primary hover:brightness-110 active:scale-95 transition-all flex items-center gap-xs"
              >
                <Play className="w-3 h-3" />
                Book Out Parts
              </button>
            </div>
          </div>
        </div>
      )}

      {showShortagePOModal && (
        <ShortageToPOModal
          shortages={auditResults}
          onClose={() => setShowShortagePOModal(false)}
          onSuccess={(po) => {
            setShowShortagePOModal(false);
            // Refresh audit after PO created
            handleValidate();
          }}
          triggerToast={triggerToast}
        />
      )}
    </div>
  );
}
