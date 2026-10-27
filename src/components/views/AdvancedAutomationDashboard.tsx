import React, { useState, useEffect } from 'react';
import { Brain, AlertCircle, TrendingUp, Zap, Plus, Loader2, BarChart3, Activity } from 'lucide-react';
import RestockOrderFiles from '../RestockOrderFiles';
import { canChange } from '../../lib/changeAccess';

interface Props {
  triggerToast: (msg: string, type?: string) => void;
  onOpenItem?: (serial: string) => void;
}

// What each kind of model does, and whether it has an accuracy to measure.
export const MODEL_KINDS: Record<string, string> = {
  DEMAND_FORECAST: 'Forecasts each part\'s use from the stock ledger; Train backtests it for a measured accuracy.',
  ANOMALY_DETECTION: 'Rule checks over stock and the ledger (negative stock, stock-outs, spikes, dead stock); Train runs a scan. No accuracy to measure.',
  SUPPLIER_RANKING: 'Scores suppliers from their purchase orders (on time) and NCRs; Train scores them.',
  DEFECT_PREDICTION: 'Would learn from inspection results; needs a history of recorded inspections first.',
};
const ANOMALY_ACTIONS: Array<[string, string]> = [['ACKNOWLEDGED', 'Acknowledge'], ['INVESTIGATING', 'Investigating'], ['RESOLVED', 'Resolved'], ['FALSE_POSITIVE', 'Not a problem']];

export default function AdvancedAutomationDashboard({ triggerToast, onOpenItem }: Props) {
  const may = canChange('/api/analytics/scan-anomalies');
  const [activeTab, setActiveTab] = useState<'overview' | 'ml_models' | 'predictive' | 'anomalies' | 'reorder' | 'supplier_intel'>('overview');
  const [models, setModels] = useState<any[]>([]);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [anomalyShow, setAnomalyShow] = useState<'open' | 'all'>('open');
  const [anomalySeverity, setAnomalySeverity] = useState('');
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModel, setShowNewModel] = useState(false);
  // Live analytics computed from inventory + ledger by the analytics engine.
  const [consumption, setConsumption] = useState<any>(null);
  const [reorder, setReorder] = useState<any>(null);
  const [anomalySummary, setAnomalySummary] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [modelForm, setModelForm] = useState({
    model_name: '',
    model_type: 'DEMAND_FORECAST',
    model_version: '1.0.0',
  });

  useEffect(() => {
    fetchAutomationData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anomalyShow, anomalySeverity]);

  const fetchAutomationData = async () => {
    setLoading(true);
    try {
      const [modelRes, predRes, anomRes, supplRes, consRes, reorderRes, anomSumRes] = await Promise.all([
        fetch('/api/ml-models'),
        fetch('/api/analytics/forecasts'),
        fetch(`/api/anomalies?${new URLSearchParams({ ...(anomalyShow === 'open' ? { status: 'open' } : {}), ...(anomalySeverity ? { severity: anomalySeverity } : {}) })}`),
        fetch('/api/supplier-intelligence'),
        fetch('/api/analytics/consumption-summary'),
        fetch('/api/analytics/reorder-recommendations'),
        fetch('/api/analytics/anomaly-summary'),
      ]);

      if (modelRes.ok) setModels(await modelRes.json());
      if (predRes.ok) setPredictions(await predRes.json());
      if (anomRes.ok) setAnomalies(await anomRes.json());
      if (supplRes.ok) setSuppliers(await supplRes.json());
      if (consRes.ok) setConsumption(await consRes.json());
      if (reorderRes.ok) setReorder(await reorderRes.json());
      if (anomSumRes.ok) setAnomalySummary(await anomSumRes.json());
    } catch (err: any) {
      triggerToast('Failed to load automation data', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  // Run the anomaly detector over live inventory + ledger data.
  const runAnomalyScan = async () => {
    setBusy('scan');
    try {
      const res = await fetch('/api/analytics/scan-anomalies', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scan failed');
      triggerToast(`Scanned ${data.scanned} items — ${data.found} anomalies found.`, 'SUCCESS');
      await fetchAutomationData();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  // Generate demand forecasts. Parts without enough history are skipped and
  // reported rather than given a fabricated number.
  const generateForecasts = async () => {
    setBusy('forecast');
    try {
      const res = await fetch('/api/analytics/generate-forecasts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ horizonDays: 30 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Forecast generation failed');
      triggerToast(
        data.generated > 0
          ? `Generated ${data.generated} forecast(s); skipped ${data.skipped} for insufficient history.`
          : `No forecasts generated — ${data.skipped} part(s) lack enough movement history.`,
        data.generated > 0 ? 'SUCCESS' : 'INFO'
      );
      await fetchAutomationData();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  // Score each supplier from its orders and NCRs.
  const assessSuppliers = async () => {
    setBusy('assess');
    try {
      const res = await fetch('/api/analytics/assess-suppliers', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Scoring failed');
      triggerToast(data.scored ? `${data.scored} of ${data.assessed} suppliers scored.` : `None scored yet: a supplier needs 3 received orders (${data.assessed} have orders).`, data.scored ? 'SUCCESS' : 'INFO');
      await fetchAutomationData();
    } catch (err: any) { triggerToast(err.message, 'ERROR'); } finally { setBusy(null); }
  };

  const setAnomaly = async (id: number, status: string) => {
    try {
      const res = await fetch(`/api/anomalies/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not change it');
      await fetchAutomationData();
    } catch (err: any) { triggerToast(err.message, 'ERROR'); }
  };

  // Backtest a model against the ledger and record the measured accuracy.
  const trainModel = async (id: number, name: string) => {
    setBusy(`train-${id}`);
    try {
      const res = await fetch(`/api/ml-models/${id}/train`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Training failed');
      triggerToast(
        data.trained
          ? `${name}: measured accuracy ${(data.accuracy * 100).toFixed(1)}% over ${data.samples} series.`
          : `${name}: ${data.note}`,
        data.trained ? 'SUCCESS' : 'INFO'
      );
      await fetchAutomationData();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    } finally {
      setBusy(null);
    }
  };

  // Only models that have actually been backtested count. Legacy rows carry a
  // hand-entered accuracy (every one said 0.8500) with last_trained_at NULL —
  // including those would report a fabricated score as "measured".
  const trainedModels = models.filter(
    m => m.accuracy !== null && m.accuracy !== undefined && m.last_trained_at
  );
  const measuredAccuracy = trainedModels.length
    ? trainedModels.reduce((a, m) => a + Number(m.accuracy), 0) / trainedModels.length
    : null;
  // Prefer server-side totals: the anomalies list endpoint caps at 100 rows, so
  // counting severities from it under-reports once more than 100 exist.
  const openAnomalyCount = anomalySummary?.open ?? anomalies.filter(a => a.status === 'DETECTED').length;
  const criticalCount = anomalySummary?.bySeverity?.CRITICAL ?? 0;
  const highCount = anomalySummary?.bySeverity?.HIGH ?? 0;

  const handleNewModel = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!modelForm.model_name) {
      triggerToast('Model name is required', 'ERROR');
      return;
    }

    try {
      const res = await fetch('/api/ml-models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(modelForm),
      });

      if (!res.ok) throw new Error('Failed to create model');

      triggerToast('ML model created', 'SUCCESS');
      setShowNewModel(false);
      setModelForm({
        model_name: '',
        model_type: 'DEMAND_FORECAST',
        model_version: '1.0.0',
      });
      fetchAutomationData();
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
            <h2 className="text-2xl font-bold text-on-surface mb-sm">Advanced Automation</h2>
            <p className="text-sm text-on-surface-variant">ML-powered predictions, anomaly detection, and intelligent automation</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-md">
            <StatCard
              icon={Brain}
              label="Active ML Models"
              value={models.filter(m => m.status === 'ACTIVE').length}
              color="text-purple-500"
            />
            <StatCard
              icon={TrendingUp}
              label="Forecasts"
              value={predictions.length}
              color="text-cyan-500"
            />
            <StatCard
              icon={AlertCircle}
              label="Detected Anomalies"
              value={openAnomalyCount}
              color="text-red-500"
            />
            <StatCard
              icon={Activity}
              label="Suppliers scored"
              value={`${suppliers.filter(s => s.performance_score !== null).length} of ${suppliers.length}`}
              color="text-green-500"
            />
          </div>

          {/* Actions that actually run the analytics engine over live data. */}
          <div className="bg-surface-container border border-outline-variant rounded-lg p-md flex flex-wrap items-center gap-sm">
            <span className="text-xs font-bold text-outline uppercase tracking-wider mr-auto">Run analysis</span>
            <button
              onClick={runAnomalyScan}
              disabled={!!busy}
              className="px-lg py-2 bg-primary text-on-primary text-xs font-bold rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2"
            >
              {busy === 'scan' ? <Loader2 className="w-4 h-4 animate-spin" /> : <AlertCircle className="w-4 h-4" />}
              {busy === 'scan' ? 'Scanning...' : 'Scan for Anomalies'}
            </button>
            <button
              onClick={generateForecasts}
              disabled={!!busy}
              className="px-lg py-2 border border-primary text-primary text-xs font-bold rounded-lg hover:bg-primary hover:text-on-primary disabled:opacity-50 flex items-center gap-2 transition-colors"
            >
              {busy === 'forecast' ? <Loader2 className="w-4 h-4 animate-spin" /> : <TrendingUp className="w-4 h-4" />}
              {busy === 'forecast' ? 'Forecasting...' : 'Generate Forecasts'}
            </button>
            <button
              onClick={assessSuppliers}
              disabled={!!busy}
              className="px-lg py-2 border border-primary text-primary text-xs font-bold rounded-lg hover:bg-primary hover:text-on-primary disabled:opacity-50 flex items-center gap-2 transition-colors"
            >
              {busy === 'assess' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
              {busy === 'assess' ? 'Scoring...' : 'Score Suppliers'}
            </button>
            <span className="basis-full text-[11px] text-outline">These also run on their own every day at 08:30 (Automation &gt; Scheduled Jobs: Stock analysis).</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Measured Forecast Accuracy</h3>
              {measuredAccuracy !== null ? (
                <>
                  <p className="text-2xl font-bold text-cyan-500">{(measuredAccuracy * 100).toFixed(1)}%</p>
                  <p className="text-xs text-on-surface-variant mt-1">
                    Backtested across {trainedModels.length} trained model{trainedModels.length === 1 ? '' : 's'}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-2xl font-bold text-outline">Not trained</p>
                  <p className="text-xs text-on-surface-variant mt-1">
                    Train a model to measure accuracy against the ledger
                  </p>
                </>
              )}
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Reorder Exposure</h3>
              <p className="text-2xl font-bold text-green-500">{reorder ? reorder.count : '—'}</p>
              <p className="text-xs text-on-surface-variant mt-1">
                {reorder
                  ? `parts need ordering · ${reorder.demandBased} demand-based, ${reorder.count - reorder.demandBased} threshold-based`
                  : 'Loading recommendations'}
              </p>
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Open Anomalies</h3>
              <p className="text-2xl font-bold text-orange-500">{openAnomalyCount}</p>
              <p className="text-xs text-on-surface-variant mt-1">
                {criticalCount} critical · {highCount} high severity
              </p>
            </div>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
            <h3 className="font-bold text-on-surface mb-3">Ledger Coverage</h3>
            {consumption ? (
              <div className="space-y-2 text-sm">
                <div className="flex items-center gap-2 text-on-surface-variant">
                  <div className="w-2 h-2 bg-cyan-500 rounded-full"></div>
                  <span>
                    {consumption.partsWithHistory} part{consumption.partsWithHistory === 1 ? '' : 's'} have consumption history
                    ({consumption.totalConsumed} units booked out in total)
                  </span>
                </div>
                <div className="flex items-center gap-2 text-on-surface-variant">
                  <div className={`w-2 h-2 rounded-full ${consumption.partsForecastable > 0 ? 'bg-green-500' : 'bg-yellow-500'}`}></div>
                  <span>
                    {consumption.partsForecastable} part{consumption.partsForecastable === 1 ? '' : 's'} have enough history to forecast
                    {consumption.partsForecastable === 0 && ' — needs 3+ movements spanning 7+ days'}
                  </span>
                </div>
                {consumption.parts?.slice(0, 3).map((p: any) => (
                  <div key={p.partNumber} className="flex items-center gap-2 text-on-surface-variant">
                    <div className={`w-2 h-2 rounded-full ${p.forecastable ? 'bg-green-500' : 'bg-outline'}`}></div>
                    <span>
                      <span className="font-mono text-primary">{p.partNumber}</span>: {p.totalConsumed} units over {p.movements} movement{p.movements === 1 ? '' : 's'} — {p.note}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-outline italic">Loading ledger coverage…</p>
            )}
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex gap-xs border-b border-outline-variant overflow-x-auto">
        {(['overview', 'ml_models', 'predictive', 'anomalies', 'reorder', 'supplier_intel'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-md py-2 text-sm font-bold whitespace-nowrap transition ${
              activeTab === tab
                ? 'text-primary border-b-2 border-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {tab === 'ml_models' ? 'ML Models'
              : tab === 'predictive' ? 'Forecasts'
              : tab === 'supplier_intel' ? 'Supplier Intel'
              : tab === 'reorder' ? 'Reorder'
              : tab === 'overview' ? 'Overview'
              : 'Anomalies'}
          </button>
        ))}
      </div>

      {/* ML Models Tab */}
      {activeTab === 'ml_models' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-bold text-on-surface">Machine Learning Models</h3>
              <p className="text-sm text-on-surface-variant">Manage and monitor ML models</p>
            </div>
            <button
              onClick={() => setShowNewModel(!showNewModel)}
              className="px-lg py-2 bg-primary text-on-primary text-xs font-bold rounded-lg hover:brightness-110 flex items-center gap-2"
            >
              <Plus className="w-4 h-4" />
              New Model
            </button>
          </div>

          {showNewModel && (
            <form onSubmit={handleNewModel} className="bg-surface-container-high rounded-lg p-md space-y-md">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Model Name *</label>
                  <input
                    type="text"
                    value={modelForm.model_name}
                    onChange={(e) => setModelForm({ ...modelForm, model_name: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                    placeholder="e.g., Demand Forecaster v1"
                  />
                </div>
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Model Type</label>
                  <select
                    value={modelForm.model_type}
                    onChange={(e) => setModelForm({ ...modelForm, model_type: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  >
                    <option>DEMAND_FORECAST</option>
                    <option>ANOMALY_DETECTION</option>
                    <option>SUPPLIER_RANKING</option>
                    <option>DEFECT_PREDICTION</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Version</label>
                  <input
                    type="text"
                    value={modelForm.model_version}
                    onChange={(e) => setModelForm({ ...modelForm, model_version: e.target.value })}
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  />
                </div>
                <p className="text-[11px] text-on-surface-variant md:col-span-2">{MODEL_KINDS[modelForm.model_type]} Accuracy is only ever measured, by Train.</p>
              </div>
              <div className="flex justify-end gap-2 pt-md border-t border-outline-variant">
                <button
                  type="button"
                  onClick={() => setShowNewModel(false)}
                  className="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-bold hover:bg-surface-container-highest"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110"
                >
                  Create Model
                </button>
              </div>
            </form>
          )}

          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading models...
            </div>
          ) : models.length === 0 ? (
            <div className="text-center py-12 text-outline">No ML models created</div>
          ) : (
            <div className="space-y-2">
              {models.map(model => (
                <div key={model.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-bold text-on-surface text-sm">{model.model_name}</p>
                      <p className="text-xs text-on-surface-variant">{model.model_type} • v{model.model_version}</p>
                      <p className="text-[11px] text-outline max-w-[620px]">{model.model_metadata?.note ?? MODEL_KINDS[model.model_type] ?? ''}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="text-right">
                        {/* accuracy is NULL until a real backtest runs — guard the
                            arithmetic or this renders NaN%. */}
                        <p className="text-sm font-bold text-cyan-500">
                          {model.accuracy === null || model.accuracy === undefined
                            ? <span className="text-outline">{model.model_type === 'DEMAND_FORECAST' ? 'Unmeasured' : 'No accuracy'}</span>
                            : `${(Number(model.accuracy) * 100).toFixed(1)}%`}
                        </p>
                        <span className={`px-2 py-1 text-xs font-bold rounded ${
                          model.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400' :
                          model.status === 'TRAINING' ? 'bg-yellow-500/10 text-yellow-400' :
                          model.status === 'NEEDS_DATA' ? 'bg-orange-500/10 text-orange-400' :
                          'bg-gray-500/10 text-on-surface-variant'
                        }`}>
                          {model.status}
                        </span>
                        {model.last_trained_at && (
                          <p className="text-[10px] text-outline mt-1">
                            trained {new Date(model.last_trained_at).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                      <button
                        onClick={() => trainModel(model.id, model.model_name)}
                        disabled={!!busy}
                        title="Backtest this model against the transaction ledger"
                        className="px-3 py-1.5 rounded-lg border border-outline-variant text-xs font-bold text-on-surface hover:bg-surface-container disabled:opacity-50 flex items-center gap-1.5"
                      >
                        {busy === `train-${model.id}` ? <Loader2 className="w-3 h-3 animate-spin" /> : <Brain className="w-3 h-3" />}
                        {busy === `train-${model.id}` ? 'Training' : 'Train'}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Predictive Orders Tab */}
      {activeTab === 'predictive' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div>
            <h3 className="text-lg font-bold text-on-surface">Demand Forecasts</h3>
            <p className="text-sm text-on-surface-variant">How many of each part are expected to be used by the date shown, from its use in the stock ledger. Parts without enough history get none rather than a guess.</p>
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading forecasts...</div>
          ) : predictions.length === 0 ? (
            <div className="text-center py-12 text-outline text-sm">
              No forecasts yet. {consumption ? `${consumption.partsForecastable} part${consumption.partsForecastable === 1 ? ' has' : 's have'} enough history (3+ uses over 7+ days); ${consumption.partsWithHistory} have some.` : ''}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead><tr className="bg-surface-container-high text-[10px] uppercase text-outline border-b border-outline-variant">
                  <th className="px-3 py-2">Part</th><th className="px-3 py-2">By</th><th className="px-3 py-2 text-right">Expected use</th><th className="px-3 py-2 text-right">Confidence</th><th className="px-3 py-2">Method</th></tr></thead>
                <tbody className="divide-y divide-outline-variant/30">
                  {predictions.map((f: any) => (
                    <tr key={`${f.component_id}-${f.forecast_date}`}>
                      <td className="px-3 py-2"><span className="font-mono font-bold text-primary">{f.component_id}</span><span className="block text-[10px] text-outline">{f.name}</span></td>
                      <td className="px-3 py-2">{f.forecast_date}</td>
                      <td className="px-3 py-2 text-right font-mono">{f.forecast_quantity}</td>
                      <td className="px-3 py-2 text-right font-mono">{f.confidence_level === null ? '—' : `${Math.round(Number(f.confidence_level) * 100)}%`}</td>
                      <td className="px-3 py-2 text-[10px] text-outline">{f.forecast_method}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Reorder Recommendations Tab */}
      {activeTab === 'reorder' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div>
            <h3 className="text-lg font-bold text-on-surface">Reorder Recommendations</h3>
            <p className="text-sm text-on-surface-variant">
              Computed live from stock levels and consumption history. Parts with enough movement
              history get a demand-based quantity (lead time + safety stock); the rest fall back to
              topping up to the configured reorder level — each row states which basis was used.
            </p>
          </div>
          <RestockOrderFiles onShowNotification={(m, t) => triggerToast(m, t)} />
          {!reorder ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Computing recommendations...
            </div>
          ) : reorder.count === 0 ? (
            <div className="text-center py-12 text-outline">No parts currently need reordering.</div>
          ) : (
            <>
              <div className="text-xs text-on-surface-variant">
                {reorder.count} recommendation{reorder.count === 1 ? '' : 's'} ·{' '}
                {reorder.demandBased} demand-based · lead time {reorder.leadTimeDays}d, safety {reorder.safetyDays}d
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead>
                    <tr className="bg-surface-container-high text-[10px] uppercase text-outline border-b border-outline-variant">
                      <th className="px-3 py-2">Part</th>
                      <th className="px-3 py-2 text-right">Stock</th>
                      <th className="px-3 py-2 text-right">Reorder Lvl</th>
                      <th className="px-3 py-2 text-right">Days Cover</th>
                      <th className="px-3 py-2 text-right">Suggested Qty</th>
                      <th className="px-3 py-2">Urgency</th>
                      <th className="px-3 py-2">Basis</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/30">
                    {reorder.recommendations.slice(0, 50).map((r: any) => (
                      <tr key={r.partNumber} className="hover:bg-surface-variant/20">
                        <td className="px-3 py-2">
                          <span className="font-mono font-bold text-primary">{r.partNumber}</span>
                          <span className="block text-[10px] text-outline">{r.itemName}</span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">{r.currentStock}</td>
                        <td className="px-3 py-2 text-right font-mono text-outline">{r.reorderLevel}</td>
                        <td className="px-3 py-2 text-right font-mono">
                          {r.daysOfCover === null ? <span className="text-outline">—</span> : `${r.daysOfCover}d`}
                        </td>
                        <td className="px-3 py-2 text-right font-mono font-bold text-on-surface">{r.suggestedOrderQty}</td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-bold ${
                            r.urgency === 'CRITICAL' ? 'bg-red-500/10 text-red-400' :
                            r.urgency === 'HIGH' ? 'bg-orange-500/10 text-orange-400' :
                            r.urgency === 'MEDIUM' ? 'bg-yellow-500/10 text-yellow-400' :
                            'bg-gray-500/10 text-on-surface-variant'
                          }`}>
                            {r.urgency}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-[10px] text-outline max-w-[260px]">{r.basis}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {reorder.recommendations.length > 50 && (
                <p className="text-[10px] text-outline italic">
                  Showing the 50 most urgent of {reorder.recommendations.length} returned.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {/* Anomalies Tab */}
      {activeTab === 'anomalies' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <h3 className="text-lg font-bold text-on-surface">Detected Anomalies</h3>
            <div className="flex flex-wrap items-center gap-sm">
              <div className="flex gap-1" role="radiogroup" aria-label="Show anomalies">
                {([['open', 'Open'], ['all', 'All']] as const).map(([k, l]) => (
                  <button key={k} type="button" role="radio" aria-checked={anomalyShow === k} onClick={() => setAnomalyShow(k)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-bold border ${anomalyShow === k ? 'bg-primary text-on-primary border-primary' : 'border-outline-variant text-on-surface-variant'}`}>{l}</button>
                ))}
              </div>
              <select value={anomalySeverity} onChange={(e) => setAnomalySeverity(e.target.value)} aria-label="Severity"
                className="bg-surface-container-high border border-outline-variant rounded px-2 py-1.5 text-xs text-on-surface">
                <option value="">Any severity</option><option value="CRITICAL">Critical</option><option value="HIGH">High</option><option value="MEDIUM">Medium</option><option value="LOW">Low</option>
              </select>
            </div>
          </div>
          <p className="text-[11px] text-outline">A rescan replaces what is still open; anything acknowledged, being investigated or marked not a problem isn't raised again.</p>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading anomalies...</div>
          ) : anomalies.length === 0 ? (
            <div className="text-center py-12 text-outline">{anomalyShow === 'open' ? 'Nothing open.' : 'No anomalies detected'}</div>
          ) : (
            <div className="space-y-2 max-h-[65vh] overflow-y-auto custom-scrollbar pr-1">
              {anomalies.map(anom => {
                const kind = String(anom.description ?? '').match(/^\[([A-Z_]+)\]\s*/);
                return (
                  <div key={anom.id} className="bg-surface-container-high border border-outline-variant rounded p-3" data-anomaly={anom.id}>
                    <div className="flex flex-wrap items-start justify-between gap-sm">
                      <div className="flex-1 min-w-[240px]">
                        <p className="text-sm text-on-surface">
                          {onOpenItem && anom.entity_type === 'INVENTORY' ? <button type="button" className="font-mono font-bold text-primary hover:underline" onClick={() => onOpenItem(anom.entity_id)}>{anom.entity_id}</button> : <strong className="font-mono">{anom.entity_id}</strong>}
                          {anom.item_name ? <span className="text-xs text-on-surface-variant"> {anom.item_name}</span> : null}
                          {kind ? <span className="text-[10px] text-outline"> · {kind[1].toLowerCase().replace(/_/g, ' ')}</span> : null}
                        </p>
                        <p className="text-xs text-on-surface-variant">{kind ? anom.description.slice(kind[0].length) : anom.description || 'Anomaly detected'}</p>
                        {anom.status !== 'DETECTED' && <p className="text-[10px] text-outline">{anom.status.toLowerCase().replace('_', ' ')}{anom.acknowledged_by ? ` · ${anom.acknowledged_by}` : ''}</p>}
                      </div>
                      <div className="flex items-center gap-1 flex-wrap">
                        <span className={`px-2 py-1 text-xs font-bold rounded whitespace-nowrap ${
                          anom.severity === 'CRITICAL' ? 'bg-red-500/10 text-red-400' :
                          anom.severity === 'HIGH' ? 'bg-orange-500/10 text-orange-400' :
                          'bg-yellow-500/10 text-yellow-400'
                        }`}>{anom.severity}</span>
                        {may && ANOMALY_ACTIONS.filter(([st]) => st !== anom.status).map(([st, l]) => (
                          <button key={st} type="button" className="px-2 py-1 text-[11px] rounded hover:bg-surface-container text-on-surface-variant" onClick={() => void setAnomaly(anom.id, st)}>{l}</button>
                        ))}
                      </div>
                    </div>
                  </div>
                );
              })}
              {anomalies.length === 500 && <p className="text-[10px] text-outline italic">Showing the first 500; narrow it by severity.</p>}
            </div>
          )}
        </div>
      )}

      {/* Supplier Intelligence Tab */}
      {activeTab === 'supplier_intel' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <div className="flex flex-wrap items-center justify-between gap-sm">
            <div>
              <h3 className="text-lg font-bold text-on-surface">Supplier Intelligence & Rankings</h3>
              <p className="text-sm text-on-surface-variant">Scored from what happened: on time (60%, where expected and received dates are both known) and orders without an NCR (40%). A supplier needs 3 received orders to be scored.</p>
            </div>
            {may && <button onClick={assessSuppliers} disabled={!!busy} className="px-lg py-2 bg-primary text-on-primary text-xs font-bold rounded-lg hover:brightness-110 disabled:opacity-50 flex items-center gap-2">
              {busy === 'assess' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />} Score suppliers</button>}
          </div>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8"><Loader2 className="w-4 h-4 animate-spin" /> Loading supplier data...</div>
          ) : suppliers.length === 0 ? (
            <div className="text-center py-12 text-outline">Not scored yet: press Score suppliers.</div>
          ) : (
            <div className="space-y-2">
              {suppliers.map(supplier => (
                <div key={supplier.id} className="bg-surface-container-high border border-outline-variant rounded p-3" data-supplier={supplier.supplier_name ?? supplier.supplier_id}>
                  <div className="flex items-center justify-between gap-sm">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{supplier.supplier_name ?? `Supplier ${supplier.supplier_id}`}</p>
                      <div className="flex gap-md mt-1 text-xs">
                        <span className="text-on-surface-variant">On time: <strong className="text-on-surface">{supplier.on_time_delivery_pct === null ? '—' : `${Number(supplier.on_time_delivery_pct)}%`}</strong></span>
                        <span className="text-on-surface-variant">Quality: <strong className="text-on-surface">{supplier.quality_score === null ? '—' : Number(supplier.quality_score)}</strong></span>
                        {supplier.last_assessed_date && <span className="text-outline">scored {new Date(supplier.last_assessed_date).toLocaleDateString('en-ZA')}</span>}
                      </div>
                      {supplier.notes && <p className="text-[11px] text-outline mt-1">{supplier.notes}</p>}
                    </div>
                    <div className="text-right">
                      <p className={`text-lg font-bold ${supplier.performance_score === null ? 'text-outline text-xs' : 'text-cyan-500'}`}>{supplier.performance_score === null ? 'Not enough orders' : Number(supplier.performance_score).toFixed(1)}</p>
                      {supplier.is_preferred && <p className="text-xs text-green-400 font-bold">PREFERRED</p>}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
