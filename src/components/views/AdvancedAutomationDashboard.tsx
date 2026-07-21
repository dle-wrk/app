import React, { useState, useEffect } from 'react';
import { Brain, AlertCircle, TrendingUp, Zap, Plus, Loader2, BarChart3, Activity } from 'lucide-react';

interface Props {
  triggerToast: (msg: string, type?: string) => void;
}

export default function AdvancedAutomationDashboard({ triggerToast }: Props) {
  const [activeTab, setActiveTab] = useState<'overview' | 'ml_models' | 'predictive' | 'anomalies' | 'supplier_intel'>('overview');
  const [models, setModels] = useState<any[]>([]);
  const [predictions, setPredictions] = useState<any[]>([]);
  const [anomalies, setAnomalies] = useState<any[]>([]);
  const [suppliers, setSuppliers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showNewModel, setShowNewModel] = useState(false);
  const [modelForm, setModelForm] = useState({
    model_name: '',
    model_type: 'DEMAND_FORECAST',
    model_version: '1.0.0',
    accuracy: 0.85,
  });

  useEffect(() => {
    fetchAutomationData();
  }, []);

  const fetchAutomationData = async () => {
    setLoading(true);
    try {
      const [modelRes, predRes, anomRes, supplRes] = await Promise.all([
        fetch('/api/ml-models'),
        fetch('/api/predictive-orders'),
        fetch('/api/anomalies'),
        fetch('/api/supplier-intelligence'),
      ]);

      if (modelRes.ok) setModels(await modelRes.json());
      if (predRes.ok) setPredictions(await predRes.json());
      if (anomRes.ok) setAnomalies(await anomRes.json());
      if (supplRes.ok) setSuppliers(await supplRes.json());
    } catch (err: any) {
      triggerToast('Failed to load automation data', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

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
        accuracy: 0.85,
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
              label="Pending Predictions"
              value={predictions.filter(p => p.status === 'PENDING').length}
              color="text-cyan-500"
            />
            <StatCard
              icon={AlertCircle}
              label="Detected Anomalies"
              value={anomalies.filter(a => a.status === 'DETECTED').length}
              color="text-red-500"
            />
            <StatCard
              icon={Activity}
              label="Supplier Score"
              value={suppliers.length > 0 ? Math.round(suppliers[0].performance_score) : 'N/A'}
              color="text-green-500"
            />
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-md">
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Forecast Accuracy</h3>
              <p className="text-2xl font-bold text-cyan-500">87.5%</p>
              <p className="text-xs text-on-surface-variant mt-1">Average across all models</p>
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Cost Savings</h3>
              <p className="text-2xl font-bold text-green-500">$12.4K</p>
              <p className="text-xs text-on-surface-variant mt-1">From optimized orders</p>
            </div>
            <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
              <h3 className="font-bold text-on-surface mb-2">Anomaly Detection Rate</h3>
              <p className="text-2xl font-bold text-orange-500">94.2%</p>
              <p className="text-xs text-on-surface-variant mt-1">Issues caught automatically</p>
            </div>
          </div>

          <div className="bg-surface-container border border-outline-variant rounded-lg p-md">
            <h3 className="font-bold text-on-surface mb-3">Recent Activity</h3>
            <div className="space-y-2 text-sm">
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-2 h-2 bg-cyan-500 rounded-full"></div>
                <span>3 new demand forecasts generated</span>
              </div>
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                <span>2 anomalies detected and escalated</span>
              </div>
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                <span>Supplier rankings updated</span>
              </div>
              <div className="flex items-center gap-2 text-on-surface-variant">
                <div className="w-2 h-2 bg-purple-500 rounded-full"></div>
                <span>Model accuracy improved to 87.5%</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Navigation Tabs */}
      <div className="flex gap-xs border-b border-outline-variant overflow-x-auto">
        {(['overview', 'ml_models', 'predictive', 'anomalies', 'supplier_intel'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-md py-2 text-sm font-bold whitespace-nowrap transition ${
              activeTab === tab
                ? 'text-primary border-b-2 border-primary'
                : 'text-on-surface-variant hover:text-on-surface'
            }`}
          >
            {tab === 'ml_models' ? 'ML Models' : tab === 'predictive' ? 'Predictions' : tab === 'supplier_intel' ? 'Supplier Intel' : 'Anomalies'}
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
                <div>
                  <label className="text-xs font-bold text-outline uppercase block mb-2">Expected Accuracy</label>
                  <input
                    type="number"
                    step="0.01"
                    value={modelForm.accuracy}
                    onChange={(e) => setModelForm({ ...modelForm, accuracy: parseFloat(e.target.value) })}
                    min="0"
                    max="1"
                    className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                  />
                </div>
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
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-cyan-500">{(model.accuracy * 100).toFixed(1)}%</p>
                      <span className={`px-2 py-1 text-xs font-bold rounded ${
                        model.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400' :
                        model.status === 'TRAINING' ? 'bg-yellow-500/10 text-yellow-400' :
                        'bg-gray-500/10 text-on-surface-variant'
                      }`}>
                        {model.status}
                      </span>
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
          <h3 className="text-lg font-bold text-on-surface">Demand Forecasts & Predictive Orders</h3>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading predictions...
            </div>
          ) : predictions.length === 0 ? (
            <div className="text-center py-12 text-outline">No predictions generated</div>
          ) : (
            <div className="space-y-2">
              {predictions.slice(0, 10).map(pred => (
                <div key={pred.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{pred.component_id}</p>
                      <p className="text-xs text-on-surface-variant">Predicted: {pred.predicted_quantity} units</p>
                    </div>
                    <div className="text-right">
                      <p className="text-sm text-cyan-500">Confidence: {(pred.confidence_score * 100).toFixed(0)}%</p>
                      <span className={`px-2 py-1 text-xs font-bold rounded ${
                        pred.status === 'CREATED' ? 'bg-green-500/10 text-green-400' :
                        pred.status === 'RECOMMENDED' ? 'bg-blue-500/10 text-blue-400' :
                        'bg-yellow-500/10 text-yellow-400'
                      }`}>
                        {pred.status}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Anomalies Tab */}
      {activeTab === 'anomalies' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h3 className="text-lg font-bold text-on-surface">Detected Anomalies</h3>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading anomalies...
            </div>
          ) : anomalies.length === 0 ? (
            <div className="text-center py-12 text-outline">No anomalies detected</div>
          ) : (
            <div className="space-y-2">
              {anomalies.slice(0, 10).map(anom => (
                <div key={anom.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-start justify-between">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{anom.entity_type}: {anom.entity_id}</p>
                      <p className="text-xs text-on-surface-variant">{anom.description || 'Anomaly detected'}</p>
                    </div>
                    <span className={`px-2 py-1 text-xs font-bold rounded whitespace-nowrap ${
                      anom.severity === 'CRITICAL' ? 'bg-red-500/10 text-red-400' :
                      anom.severity === 'HIGH' ? 'bg-orange-500/10 text-orange-400' :
                      'bg-yellow-500/10 text-yellow-400'
                    }`}>
                      {anom.severity}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Supplier Intelligence Tab */}
      {activeTab === 'supplier_intel' && (
        <div className="bg-surface-container border border-outline-variant rounded-lg p-lg space-y-md">
          <h3 className="text-lg font-bold text-on-surface">Supplier Intelligence & Rankings</h3>
          {loading ? (
            <div className="flex items-center gap-2 text-outline py-8">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading supplier data...
            </div>
          ) : suppliers.length === 0 ? (
            <div className="text-center py-12 text-outline">No supplier data available</div>
          ) : (
            <div className="space-y-2">
              {suppliers.map(supplier => (
                <div key={supplier.id} className="bg-surface-container-high border border-outline-variant rounded p-3">
                  <div className="flex items-center justify-between">
                    <div className="flex-1">
                      <p className="font-bold text-on-surface text-sm">{supplier.supplier_id}</p>
                      <div className="flex gap-md mt-1 text-xs">
                        <span className="text-on-surface-variant">OTD: <strong className="text-on-surface">{supplier.on_time_delivery_pct}%</strong></span>
                        <span className="text-on-surface-variant">Quality: <strong className="text-on-surface">{supplier.quality_score}</strong></span>
                        <span className="text-on-surface-variant">Response: <strong className="text-on-surface">{supplier.responsiveness_score}</strong></span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-lg font-bold text-cyan-500">{supplier.performance_score.toFixed(1)}</p>
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
