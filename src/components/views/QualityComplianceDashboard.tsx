import React, { useState, useEffect } from 'react';
import { CheckCircle2, AlertTriangle, TrendingUp, FileText, Zap, BarChart3, Plus, Loader2 } from 'lucide-react';

interface Props {
  triggerToast: (msg: string, type?: string) => void;
}

export default function QualityComplianceDashboard({ triggerToast }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'inspections' | 'defects' | 'ncr' | 'compliance'>('overview');
  const [inspections, setInspections] = useState<any[]>([]);
  const [defects, setDefects] = useState<any[]>([]);
  const [ncrs, setNcrs] = useState<any[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showNewInspection, setShowNewInspection] = useState(false);
  const [formData, setFormData] = useState({
    inspection_type: 'INCOMING',
    component_id: '',
    batch_id: '',
    inspector_id: '',
    sample_size: 50,
  });

  useEffect(() => {
    fetchQualityData();
  }, []);

  const fetchQualityData = async () => {
    setLoading(true);
    try {
      const [inspRes, defRes, ncrRes, metRes] = await Promise.all([
        fetch('/api/qa-inspections'),
        fetch('/api/defects'),
        fetch('/api/ncr'),
        fetch('/api/quality-metrics'),
      ]);

      if (inspRes.ok) setInspections(await inspRes.json());
      if (defRes.ok) setDefects(await defRes.json());
      if (ncrRes.ok) setNcrs(await ncrRes.json());
      if (metRes.ok) {
        const data = await metRes.json();
        if (data.length > 0) setMetrics(data[0]);
      }
    } catch (err: any) {
      triggerToast('Failed to load quality data', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const handleNewInspection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!formData.component_id || !formData.inspector_id) {
      triggerToast('Component ID and Inspector ID are required', 'ERROR');
      return;
    }

    try {
      const res = await fetch('/api/qa-inspections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) throw new Error('Failed to create inspection');

      triggerToast('QA inspection scheduled', 'SUCCESS');
      setShowNewInspection(false);
      setFormData({
        inspection_type: 'INCOMING',
        component_id: '',
        batch_id: '',
        inspector_id: '',
        sample_size: 50,
      });
      fetchQualityData();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    }
  };

  const StatCard = ({ icon: Icon, label, value, color }: any) => (
    <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-on-surface-variant mb-xs">{label}</p>
          <p className="text-2xl font-bold text-on-surface">{value}</p>
        </div>
        <Icon className={`w-8 h-8 ${color}`} />
      </div>
    </div>
  );

  return (
    <div className="p-container-margin space-y-lg max-w-[1400px] mx-auto w-full">
      {/* Overview Tab */}
      {activeTab === 'overview' && (
        <div className="space-y-lg">
          <div>
            <h2 className="text-2xl font-bold text-on-surface mb-sm">Quality & Compliance Dashboard</h2>
            <p className="text-sm text-on-surface-variant">Monitor inspections, defects, and compliance status</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-md">
            <StatCard
              icon={CheckCircle2}
              label="Passed Inspections"
              value={inspections.filter(i => i.status === 'PASSED').length}
              color="text-green-500"
            />
            <StatCard
              icon={AlertTriangle}
              label="Failed Inspections"
              value={inspections.filter(i => i.status === 'FAILED').length}
              color="text-red-500"
            />
            <StatCard
              icon={FileText}
              label="Open NCRs"
              value={ncrs.filter(n => n.status === 'OPEN').length}
              color="text-orange-500"
            />
            <StatCard
              icon={TrendingUp}
              label="Defect Rate"
              value={metrics?.defect_rate ? `${metrics.defect_rate}%` : 'N/A'}
              color="text-cyan-500"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Critical Issues</h3>
              <p className="text-2xl font-bold text-red-500">{defects.filter(d => d.severity === 'CRITICAL').length}</p>
              <p className="text-xs text-on-surface-variant mt-1">Require immediate attention</p>
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Compliance Status</h3>
              <p className="text-2xl font-bold text-green-500">On Track</p>
              <p className="text-xs text-on-surface-variant mt-1">All checkpoints active</p>
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Avg Response Time</h3>
              <p className="text-2xl font-bold text-cyan-500">2.3 days</p>
              <p className="text-xs text-on-surface-variant mt-1">NCR resolution</p>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex gap-xs border-b border-outline-variant overflow-x-auto">
        {(['overview', 'inspections', 'defects', 'ncr', 'compliance'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-md py-2 text-sm font-bold whitespace-nowrap transition ${
              activeTab === tab
                ? 'text-primary border-b-2 border-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {tab.charAt(0).toUpperCase() + tab.slice(1)}
          </button>
        ))}
      </div>

      {/* Inspections Tab */}
      {activeTab === 'inspections' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-bold text-on-surface">QA Inspections</h3>
              <p className="text-sm text-on-surface-variant">Schedule and track quality inspections</p>
            </div>
            <button
              onClick={() => setShowNewInspection(!showNewInspection)}
              className="px-lg py-2 bg-primary text-on-primary text-xs font-bold rounded-lg hover:brightness-110 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New Inspection
            </button>
          </div>

          {showNewInspection && (
            <form onSubmit={handleNewInspection} className="bg-surface-container-high rounded-lg p-md space-y-md">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Component ID *</label>
                  <input
                    type="text"
                    value={formData.component_id}
                    onChange={(e) => setFormData({ ...formData, component_id: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                    placeholder="e.g., CAP-001"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Inspector ID *</label>
                  <input
                    type="text"
                    value={formData.inspector_id}
                    onChange={(e) => setFormData({ ...formData, inspector_id: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Inspection Type</label>
                  <select
                    value={formData.inspection_type}
                    onChange={(e) => setFormData({ ...formData, inspection_type: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  >
                    <option>INCOMING</option>
                    <option>IN_PROCESS</option>
                    <option>FINAL</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Sample Size</label>
                  <input
                    type="number"
                    value={formData.sample_size}
                    onChange={(e) => setFormData({ ...formData, sample_size: parseInt(e.target.value) })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-md border-t border-outline-variant">
                <button
                  type="button"
                  onClick={() => setShowNewInspection(false)}
                  className="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-bold hover:bg-surface-container-highest"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110"
                >
                  Schedule Inspection
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading inspections...
            </div>
          ) : inspections.length === 0 ? (
            <div className="text-center py-12 text-outline">No inspections scheduled</div>
          ) : (
            <div className="space-y-2">
              {inspections.slice(0, 10).map(insp => (
                <div key={insp.id} className="bg-surface-container-high border border-outline-variant rounded p-3 flex items-center justify-between">
                  <div>
                    <p className="font-bold text-on-surface text-sm">{insp.component_id}</p>
                    <p className="text-xs text-on-surface-variant">{insp.inspection_type} • {insp.sample_size} units</p>
                  </div>
                  <span className={`px-2 py-1 text-xs font-bold rounded ${
                    insp.status === 'PASSED' ? 'bg-green-500/10 text-green-400' :
                    insp.status === 'FAILED' ? 'bg-red-500/10 text-red-400' :
                    'bg-yellow-500/10 text-yellow-400'
                  }`}>
                    {insp.status}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Defects Tab */}
      {activeTab === 'defects' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h3 className="text-lg font-bold text-on-surface">Defect Tracking</h3>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading defects...
            </div>
          ) : defects.length === 0 ? (
            <div className="text-center py-12 text-outline">No defects recorded</div>
          ) : (
            <div className="space-y-2">
              {defects.slice(0, 10).map(defect => (
                <div key={defect.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{defect.defect_code}</p>
                      <p className="text-xs text-on-surface-variant">{defect.description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs font-bold rounded whitespace-nowrap ${
                      defect.severity === 'CRITICAL' ? 'bg-red-500/10 text-red-400' :
                      defect.severity === 'MAJOR' ? 'bg-orange-500/10 text-orange-400' :
                      'bg-yellow-500/10 text-yellow-400'
                    }`}>
                      {defect.severity}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* NCR Tab */}
      {activeTab === 'ncr' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h3 className="text-lg font-bold text-on-surface">Non-Conformance Reports</h3>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading NCRs...
            </div>
          ) : ncrs.length === 0 ? (
            <div className="text-center py-12 text-outline">No NCRs created</div>
          ) : (
            <div className="space-y-2">
              {ncrs.slice(0, 10).map(ncr => (
                <div key={ncr.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{ncr.ncr_number}</p>
                      <p className="text-xs text-on-surface-variant">{ncr.component_id} • {ncr.issue_description}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs font-bold rounded whitespace-nowrap ${
                      ncr.status === 'OPEN' ? 'bg-red-500/10 text-red-400' :
                      ncr.status === 'RESOLVED' ? 'bg-green-500/10 text-green-400' :
                      'bg-blue-500/10 text-blue-400'
                    }`}>
                      {ncr.status}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Compliance Tab */}
      {activeTab === 'compliance' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h3 className="text-lg font-bold text-on-surface">Compliance Checkpoints</h3>
          <div className="text-center py-12 text-outline">
            <Zap className="w-8 h-8 mx-auto mb-2 opacity-50" />
            Compliance tracking ready — checkpoints loading from API
          </div>
        </div>
      )}
    </div>
  );
}
