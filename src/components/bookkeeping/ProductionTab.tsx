import React, { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { BuildJob, BomStructure, SubAssembly, FieldedAsset, StockLedgerEntry } from '../../types';
import { ModuleDataProps, Modal, StatusPill, fmtDate, apiGet, apiPost, PrimaryButton, SecondaryButton, FieldLabel, inputClass, selectClass, EmptyState, SectionCard } from './shared';

type ProdSubTab = 'BUILD_JOBS' | 'BOM' | 'SUB_ASSEMBLIES' | 'FIELDED_ASSETS' | 'STOCK_LEDGER';

const SUB_TABS: { key: ProdSubTab; label: string }[] = [
  { key: 'BUILD_JOBS', label: 'Build Jobs' },
  { key: 'BOM', label: 'BOM Structures' },
  { key: 'SUB_ASSEMBLIES', label: 'Sub-Assemblies' },
  { key: 'FIELDED_ASSETS', label: 'Fielded Assets' },
  { key: 'STOCK_LEDGER', label: 'Stock Ledger' },
];

export const ProductionTab: React.FC<ModuleDataProps> = (props) => {
  const [subTab, setSubTab] = useState<ProdSubTab>('BUILD_JOBS');
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 bg-surface-container-high/40 p-1 rounded-lg w-fit">
        {SUB_TABS.map(t => (
          <button key={t.key} onClick={() => setSubTab(t.key)} className={`px-3 py-1.5 rounded text-xs font-bold transition-all ${subTab === t.key ? 'bg-primary text-white' : 'text-on-surface-variant hover:text-on-surface'}`}>{t.label}</button>
        ))}
      </div>
      {subTab === 'BUILD_JOBS' && <BuildJobsPanel {...props} />}
      {subTab === 'BOM' && <BomStructuresPanel {...props} />}
      {subTab === 'SUB_ASSEMBLIES' && <SubAssembliesPanel {...props} />}
      {subTab === 'FIELDED_ASSETS' && <FieldedAssetsPanel {...props} />}
      {subTab === 'STOCK_LEDGER' && <StockLedgerPanel {...props} />}
    </div>
  );
};

function useEntityList<T>(endpoint: string, triggerToast: ModuleDataProps['triggerToast']) {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const load = async () => {
    setLoading(true);
    try {
      const data = await apiGet(endpoint);
      setRows(Array.isArray(data) ? data : []);
    } catch (err: any) {
      triggerToast(err.message || `Failed to load ${endpoint}`, 'ERROR');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, [endpoint]);
  return { rows, loading, reload: load };
}

// ============================================================================
// BUILD JOBS
// ============================================================================

const BuildJobsPanel: React.FC<ModuleDataProps> = ({ clientOrders, triggerToast }) => {
  const { rows, loading, reload } = useEntityList<BuildJob>('/api/build-jobs', triggerToast);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <SectionCard title="Build Jobs" badge={`${rows.length} jobs`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Build Job</PrimaryButton>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Job #</th><th className="px-lg py-sm">Status</th><th className="px-lg py-sm text-right">Qty</th><th className="px-lg py-sm">Start</th><th className="px-lg py-sm">End</th><th className="px-lg py-sm">Team</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {rows.map(j => (
              <tr key={j.id} className="hover:bg-surface-variant/20"><td className="px-lg py-sm font-mono text-primary font-bold">{j.jobNumber}</td><td className="px-lg py-sm"><StatusPill status={j.status} /></td><td className="px-lg py-sm text-right font-mono">{j.buildQty}</td><td className="px-lg py-sm text-on-surface-variant">{fmtDate(j.startDate)}</td><td className="px-lg py-sm text-on-surface-variant">{fmtDate(j.endDate)}</td><td className="px-lg py-sm text-on-surface-variant">{j.assignedTeam || '—'}</td></tr>
            ))}
            {!loading && rows.length === 0 && <EmptyState message="No build jobs yet." colSpan={6} />}
          </tbody>
        </table>
      </div>
      {showCreate && (
        <QuickCreateModal
          title="New Build Job"
          fields={[
            { key: 'jobNumber', label: 'Job Number', required: true },
            { key: 'buildQty', label: 'Build Quantity', type: 'number' },
            { key: 'assignedTeam', label: 'Assigned Team' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => { await apiPost('/api/build-jobs', data); }}
          onSaved={async () => { setShowCreate(false); await reload(); }}
          triggerToast={triggerToast}
        />
      )}
    </SectionCard>
  );
};

// ============================================================================
// BOM STRUCTURES
// ============================================================================

const BomStructuresPanel: React.FC<ModuleDataProps> = ({ triggerToast }) => {
  const { rows, loading, reload } = useEntityList<BomStructure>('/api/bom-structures', triggerToast);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <SectionCard title="BOM Structures" badge={`${rows.length} entries`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New BOM Entry</PrimaryButton>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Parent Part #</th><th className="px-lg py-sm">Child Part #</th><th className="px-lg py-sm text-right">Qty</th><th className="px-lg py-sm">Description</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {rows.map(b => (
              <tr key={b.id} className="hover:bg-surface-variant/20"><td className="px-lg py-sm font-mono">{b.parentPartNumber}</td><td className="px-lg py-sm font-mono">{b.childPartNumber}</td><td className="px-lg py-sm text-right font-mono">{b.quantity}</td><td className="px-lg py-sm text-on-surface-variant">{b.description || '—'}</td></tr>
            ))}
            {!loading && rows.length === 0 && <EmptyState message="No BOM entries yet." colSpan={4} />}
          </tbody>
        </table>
      </div>
      {showCreate && (
        <QuickCreateModal
          title="New BOM Entry"
          fields={[
            { key: 'parentPartNumber', label: 'Parent Part #', required: true },
            { key: 'childPartNumber', label: 'Child Part #', required: true },
            { key: 'quantity', label: 'Quantity', type: 'number' },
            { key: 'description', label: 'Description' },
          ]}
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => { await apiPost('/api/bom-structures', data); }}
          onSaved={async () => { setShowCreate(false); await reload(); }}
          triggerToast={triggerToast}
        />
      )}
    </SectionCard>
  );
};

// ============================================================================
// SUB-ASSEMBLIES
// ============================================================================

const SubAssembliesPanel: React.FC<ModuleDataProps> = ({ triggerToast }) => {
  const { rows, loading, reload } = useEntityList<SubAssembly>('/api/sub-assemblies', triggerToast);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <SectionCard title="Sub-Assemblies" badge={`${rows.length} entries`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Sub-Assembly</PrimaryButton>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Assembly Name</th><th className="px-lg py-sm">Parent Part #</th><th className="px-lg py-sm">Child Part #</th><th className="px-lg py-sm text-right">Qty</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {rows.map(s => (
              <tr key={s.id} className="hover:bg-surface-variant/20"><td className="px-lg py-sm font-bold">{s.assemblyName}</td><td className="px-lg py-sm font-mono text-on-surface-variant">{s.parentPartNumber || '—'}</td><td className="px-lg py-sm font-mono text-on-surface-variant">{s.childPartNumber || '—'}</td><td className="px-lg py-sm text-right font-mono">{s.quantity}</td></tr>
            ))}
            {!loading && rows.length === 0 && <EmptyState message="No sub-assemblies yet." colSpan={4} />}
          </tbody>
        </table>
      </div>
      {showCreate && (
        <QuickCreateModal
          title="New Sub-Assembly"
          fields={[
            { key: 'assemblyName', label: 'Assembly Name', required: true },
            { key: 'parentPartNumber', label: 'Parent Part #' },
            { key: 'childPartNumber', label: 'Child Part #' },
            { key: 'quantity', label: 'Quantity', type: 'number' },
            { key: 'description', label: 'Description' },
          ]}
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => { await apiPost('/api/sub-assemblies', data); }}
          onSaved={async () => { setShowCreate(false); await reload(); }}
          triggerToast={triggerToast}
        />
      )}
    </SectionCard>
  );
};

// ============================================================================
// FIELDED ASSETS
// ============================================================================

const FieldedAssetsPanel: React.FC<ModuleDataProps> = ({ clients, triggerToast }) => {
  const { rows, loading, reload } = useEntityList<FieldedAsset>('/api/fielded-assets', triggerToast);
  const [showCreate, setShowCreate] = useState(false);
  const clientName = (id?: number) => clients.find(c => c.id === id)?.clientName || '—';

  return (
    <SectionCard title="Fielded Assets" badge={`${rows.length} assets`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Fielded Asset</PrimaryButton>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Asset Tag</th><th className="px-lg py-sm">Client</th><th className="px-lg py-sm">Serial #</th><th className="px-lg py-sm">Status</th><th className="px-lg py-sm">Location</th><th className="px-lg py-sm">Installed</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {rows.map(a => (
              <tr key={a.id} className="hover:bg-surface-variant/20"><td className="px-lg py-sm font-mono text-primary font-bold">{a.assetTag}</td><td className="px-lg py-sm">{clientName(a.clientId)}</td><td className="px-lg py-sm font-mono text-on-surface-variant">{a.serialNumber || '—'}</td><td className="px-lg py-sm"><StatusPill status={a.status} /></td><td className="px-lg py-sm text-on-surface-variant">{a.location || '—'}</td><td className="px-lg py-sm text-on-surface-variant">{fmtDate(a.installedDate)}</td></tr>
            ))}
            {!loading && rows.length === 0 && <EmptyState message="No fielded assets yet." colSpan={6} />}
          </tbody>
        </table>
      </div>
      {showCreate && (
        <QuickCreateModal
          title="New Fielded Asset"
          fields={[
            { key: 'assetTag', label: 'Asset Tag', required: true },
            { key: 'serialNumber', label: 'Serial Number' },
            { key: 'location', label: 'Location' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => { await apiPost('/api/fielded-assets', data); }}
          onSaved={async () => { setShowCreate(false); await reload(); }}
          triggerToast={triggerToast}
        />
      )}
    </SectionCard>
  );
};

// ============================================================================
// STOCK LEDGER
// ============================================================================

const StockLedgerPanel: React.FC<ModuleDataProps> = ({ items, triggerToast }) => {
  const { rows, loading, reload } = useEntityList<StockLedgerEntry>('/api/stock-ledger', triggerToast);
  const [showCreate, setShowCreate] = useState(false);

  return (
    <SectionCard title="Stock Ledger" badge={`${rows.length} movements`} actions={<PrimaryButton icon={<Plus className="w-3.5 h-3.5" />} onClick={() => setShowCreate(true)}>New Movement</PrimaryButton>}>
      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse text-xs">
          <thead><tr className="bg-surface-container-high/50 text-[10px] uppercase font-bold text-outline border-b border-outline-variant"><th className="px-lg py-sm">Part #</th><th className="px-lg py-sm">Movement</th><th className="px-lg py-sm text-right">Qty</th><th className="px-lg py-sm">Date</th><th className="px-lg py-sm">Reference</th></tr></thead>
          <tbody className="divide-y divide-outline-variant/30">
            {rows.slice(0, 200).map(l => (
              <tr key={l.id} className="hover:bg-surface-variant/20"><td className="px-lg py-sm font-mono">{l.itemSerialNumber || '—'}</td><td className="px-lg py-sm">{l.movementType}</td><td className="px-lg py-sm text-right font-mono">{l.quantity}</td><td className="px-lg py-sm text-on-surface-variant">{fmtDate(l.movementDate)}</td><td className="px-lg py-sm text-on-surface-variant">{l.reference || '—'}</td></tr>
            ))}
            {!loading && rows.length === 0 && <EmptyState message="No stock movements recorded yet." colSpan={5} />}
          </tbody>
        </table>
      </div>
      {showCreate && (
        <QuickCreateModal
          title="New Stock Movement"
          fields={[
            { key: 'itemSerialNumber', label: 'Part Number', required: true, options: items.map(i => ({ value: i.partNumber, label: `${i.partNumber} — ${i.name}` })) },
            { key: 'movementType', label: 'Movement Type', required: true, options: [{ value: 'INBOUND', label: 'Inbound' }, { value: 'OUTBOUND', label: 'Outbound' }, { value: 'ADJUSTMENT', label: 'Adjustment' }] },
            { key: 'quantity', label: 'Quantity', type: 'number', required: true },
            { key: 'reference', label: 'Reference' },
            { key: 'notes', label: 'Notes', type: 'textarea' },
          ]}
          onClose={() => setShowCreate(false)}
          onSubmit={async (data) => { await apiPost('/api/stock-ledger', data); }}
          onSaved={async () => { setShowCreate(false); await reload(); }}
          triggerToast={triggerToast}
        />
      )}
    </SectionCard>
  );
};

// ============================================================================
// GENERIC QUICK-CREATE MODAL
// ============================================================================

interface FieldDef {
  key: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'select';
  required?: boolean;
  options?: { value: string; label: string }[];
}

const QuickCreateModal: React.FC<{ title: string; fields: FieldDef[]; onClose: () => void; onSubmit: (data: Record<string, any>) => Promise<void>; onSaved: () => void; triggerToast: ModuleDataProps['triggerToast'] }> = ({ title, fields, onClose, onSubmit, onSaved, triggerToast }) => {
  const [values, setValues] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    for (const f of fields) {
      if (f.required && !values[f.key]) {
        triggerToast(`${f.label} is required.`, 'ERROR');
        return;
      }
    }
    setSaving(true);
    try {
      await onSubmit(values);
      triggerToast(`${title.replace('New ', '')} created.`);
      onSaved();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save', 'ERROR');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={title} onClose={onClose} maxWidth="max-w-lg">
      <div className="space-y-3">
        {fields.map(f => (
          <div key={f.key}>
            <FieldLabel>{f.label}</FieldLabel>
            {f.type === 'textarea' ? (
              <textarea className={inputClass} rows={2} value={values[f.key] || ''} onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))} />
            ) : f.options ? (
              <select className={selectClass} value={values[f.key] || ''} onChange={(e) => setValues(v => ({ ...v, [f.key]: e.target.value }))}>
                <option value="">Select...</option>
                {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : (
              <input
                type={f.type === 'number' ? 'number' : 'text'}
                className={inputClass}
                value={values[f.key] ?? ''}
                onChange={(e) => setValues(v => ({ ...v, [f.key]: f.type === 'number' ? parseFloat(e.target.value) || 0 : e.target.value }))}
              />
            )}
          </div>
        ))}
      </div>
      <div className="flex justify-end gap-2 pt-md mt-md border-t border-outline-variant/20">
        <SecondaryButton onClick={onClose}>Cancel</SecondaryButton>
        <PrimaryButton onClick={submit} disabled={saving}>{saving ? 'Saving...' : 'Create'}</PrimaryButton>
      </div>
    </Modal>
  );
};
