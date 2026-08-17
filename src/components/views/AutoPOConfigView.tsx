import React, { useState, useEffect } from 'react';
import { Plus, Edit2, Trash2, ToggleRight, Loader2, AlertTriangle, X, ChevronDown } from 'lucide-react';

interface AutoPOConfig {
  id: number;
  componentIds: string[];
  minStockLevel: number;
  autoPOThreshold: number;
  preferredSupplier: string;
  autoSupplierSelect: boolean;
  autoApprove: boolean;
  enabled: boolean;
}

interface ComponentOption {
  id: string;
  name: string;
  // Add other component properties as needed
}

interface Props {
  triggerToast: (msg: string, type?: string) => void;
}

export default function AutoPOConfigView({ triggerToast }: Props) {
  const [configs, setConfigs] = useState<AutoPOConfig[]>([]);
  const [components, setComponents] = useState<ComponentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [componentSearch, setComponentSearch] = useState('');
  const [showComponentDropdown, setShowComponentDropdown] = useState(false);
  const [formData, setFormData] = useState({
    componentIds: [] as string[],
    minStockLevel: 50,
    autoPOThreshold: 10,
    preferredSupplier: 'digikey',
    autoSupplierSelect: true,
    autoApprove: false,
  });

  useEffect(() => {
    fetchConfigs();
    fetchComponents();
  }, []);

  const fetchConfigs = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/auto-po-config');
      setConfigs(await res.json());
    } catch (err: any) {
      triggerToast('Failed to load auto-PO configurations', 'ERROR');
    } finally {
      setLoading(false);
    }
  };

  const fetchComponents = async () => {
    try {
      // Replace with your actual API endpoint for fetching components
      const res = await fetch('/api/components');
      setComponents(await res.json());
    } catch (err: any) {
      triggerToast('Failed to load components', 'ERROR');
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formData.componentIds.length === 0) {
      triggerToast('At least one component ID is required', 'ERROR');
      return;
    }

    try {
      const method = editingId ? 'PUT' : 'POST';
      const url = editingId
        ? `/api/auto-po-config/${editingId}`
        : '/api/auto-po-config';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(formData),
      });

      if (!res.ok) throw new Error('Failed to save configuration');

      triggerToast(
        editingId ? 'Auto-PO config updated' : 'Auto-PO config created',
        'SUCCESS'
      );

      resetForm();
      fetchConfigs();
    } catch (err: any) {
      triggerToast(err.message || 'Failed to save configuration', 'ERROR');
    }
  };

  const handleToggle = async (id: number, enabled: boolean) => {
    try {
      const res = await fetch(`/api/auto-po-config/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });

      if (!res.ok) throw new Error('Failed to update');

      triggerToast(enabled ? 'Auto-PO disabled' : 'Auto-PO enabled', 'SUCCESS');
      fetchConfigs();
    } catch (err: any) {
      triggerToast(err.message, 'ERROR');
    }
  };

  const handleEdit = (config: AutoPOConfig) => {
    setEditingId(config.id);
    setFormData({
      componentIds: config.componentIds,
      minStockLevel: config.minStockLevel,
      autoPOThreshold: config.autoPOThreshold,
      preferredSupplier: config.preferredSupplier,
      autoSupplierSelect: config.autoSupplierSelect,
      autoApprove: config.autoApprove,
    });
    setShowForm(true);
  };

  const addComponent = (componentId: string) => {
    if (!formData.componentIds.includes(componentId)) {
      setFormData({
        ...formData,
        componentIds: [...formData.componentIds, componentId]
      });
    }
    setComponentSearch('');
    setShowComponentDropdown(false);
  };

  const removeComponent = (componentId: string) => {
    setFormData({
      ...formData,
      componentIds: formData.componentIds.filter(id => id !== componentId)
    });
  };

  const resetForm = () => {
    setShowForm(false);
    setEditingId(null);
    setComponentSearch('');
    setShowComponentDropdown(false);
    setFormData({
      componentIds: [],
      minStockLevel: 50,
      autoPOThreshold: 10,
      preferredSupplier: 'digikey',
      autoSupplierSelect: true,
      autoApprove: false,
    });
  };

  const filteredComponents = components.filter(comp =>
    comp.id.toLowerCase().includes(componentSearch.toLowerCase()) ||
    comp.name.toLowerCase().includes(componentSearch.toLowerCase())
  );

  return (
    <div className="p-container-margin space-y-lg max-w-[1400px] mx-auto w-full">
      <div className="bg-surface-container border border-outline-variant p-lg rounded-xl">
        <div className="flex justify-between items-center mb-lg">
          <div>
            <h3 className="text-lg font-bold text-on-surface">Auto-PO Configuration</h3>
            <p className="text-sm text-on-surface-variant">Configure automatic purchase order settings for multiple components</p>
          </div>
          <button
            onClick={() => {
              resetForm();
              setShowForm(true);
            }}
            className="px-lg py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110 transition flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Configuration
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleSubmit} className="bg-surface-container-high rounded-lg p-md mb-lg space-y-md">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
              <div className="md:col-span-2">
                <label className="text-xs font-bold text-outline uppercase block mb-2">
                  Component IDs *
                </label>
                
                {/* Multi-select component dropdown */}
                <div className="relative">
                  <div className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 min-h-[42px] flex flex-wrap gap-2 items-center cursor-text"
                    onClick={() => setShowComponentDropdown(true)}
                  >
                    {formData.componentIds.map(id => (
                      <span key={id} className="inline-flex items-center gap-1 bg-primary/10 text-primary px-2 py-1 rounded text-xs font-medium">
                        {id}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            removeComponent(id);
                          }}
                          className="hover:bg-primary/20 rounded-full p-0.5"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </span>
                    ))}
                    <input
                      type="text"
                      value={componentSearch}
                      onChange={(e) => {
                        setComponentSearch(e.target.value);
                        setShowComponentDropdown(true);
                      }}
                      onFocus={() => setShowComponentDropdown(true)}
                      placeholder={formData.componentIds.length === 0 ? "Search and select components..." : ""}
                      className="flex-1 min-w-[120px] bg-transparent border-none outline-none text-sm text-on-surface placeholder:text-outline"
                    />
                    <ChevronDown className="w-4 h-4 text-outline" />
                  </div>

                  {/* Dropdown list */}
                  {showComponentDropdown && (
                    <div className="absolute z-10 w-full mt-1 bg-surface-container border border-outline-variant rounded-lg shadow-lg max-h-60 overflow-y-auto">
                      {filteredComponents.length > 0 ? (
                        filteredComponents.map(comp => (
                          <button
                            key={comp.id}
                            type="button"
                            onClick={() => addComponent(comp.id)}
                            className={`w-full px-3 py-2 text-left text-sm hover:bg-surface-container-highest transition flex items-center justify-between ${
                              formData.componentIds.includes(comp.id) ? 'bg-primary/5' : ''
                            }`}
                          >
                            <span className="font-mono text-on-surface">{comp.id}</span>
                            <span className="text-xs text-outline">{comp.name}</span>
                            {formData.componentIds.includes(comp.id) && (
                              <span className="text-primary text-xs">✓ Selected</span>
                            )}
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-2 text-sm text-outline italic">
                          No components found
                        </div>
                      )}
                    </div>
                  )}
                </div>
                
                {/* Selected components summary */}
                {formData.componentIds.length > 0 && (
                  <p className="text-xs text-outline mt-2">
                    {formData.componentIds.length} component{formData.componentIds.length !== 1 ? 's' : ''} selected
                  </p>
                )}
              </div>

              <div>
                <label className="text-xs font-bold text-outline uppercase block mb-2">Min Stock Level</label>
                <input
                  type="number"
                  value={formData.minStockLevel}
                  onChange={(e) => setFormData({ ...formData, minStockLevel: parseInt(e.target.value) })}
                  className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-outline uppercase block mb-2">Auto-PO Threshold</label>
                <input
                  type="number"
                  value={formData.autoPOThreshold}
                  onChange={(e) => setFormData({ ...formData, autoPOThreshold: parseInt(e.target.value) })}
                  className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                />
              </div>
              <div>
                <label className="text-xs font-bold text-outline uppercase block mb-2">Preferred Supplier</label>
                <select
                  value={formData.preferredSupplier}
                  onChange={(e) => setFormData({ ...formData, preferredSupplier: e.target.value })}
                  className="w-full bg-surface-container border border-outline-variant rounded px-3 py-2 text-sm text-on-surface"
                >
                  <option value="">Auto-select</option>
                  <option value="digikey">DigiKey</option>
                  <option value="mouser">Mouser</option>
                  <option value="lcsc">LCSC</option>
                </select>
              </div>
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.autoSupplierSelect}
                  onChange={(e) => setFormData({ ...formData, autoSupplierSelect: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm text-on-surface">Auto-select best supplier based on performance</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formData.autoApprove}
                  onChange={(e) => setFormData({ ...formData, autoApprove: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm text-on-surface">Auto-approve generated purchase orders</span>
              </label>
            </div>

            <div className="flex justify-end gap-2 pt-md border-t border-outline-variant">
              <button
                type="button"
                onClick={resetForm}
                className="px-4 py-2 rounded-lg bg-surface-container text-on-surface text-xs font-bold hover:bg-surface-container-highest transition"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110 transition"
              >
                {editingId ? 'Update' : 'Create'} Configuration
              </button>
            </div>
          </form>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-8 gap-2 text-outline">
            <Loader2 className="w-4 h-4 animate-spin" />
            Loading configurations...
          </div>
        ) : configs.length === 0 ? (
          <div className="text-center py-12 text-outline italic">
            <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-50" />
            No auto-PO configurations yet. Create one to enable automatic purchase orders.
          </div>
        ) : (
          <div className="space-y-md">
            {configs.map(config => (
              <div
                key={config.id}
                className="bg-surface-container-high border border-outline-variant rounded-lg p-md hover:border-primary transition-colors"
              >
                <div className="flex items-start justify-between gap-md">
                  <div className="flex-1 space-y-2">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="text-sm font-bold text-on-surface">
                        {config.componentIds.length} Component{config.componentIds.length !== 1 ? 's' : ''}
                      </h4>
                      <span className={`px-2 py-1 rounded text-[9px] font-bold ${
                        config.enabled
                          ? 'bg-green-500/10 text-green-400'
                          : 'bg-gray-500/10 text-outline'
                      }`}>
                        {config.enabled ? 'ENABLED' : 'DISABLED'}
                      </span>
                    </div>
                    
                    {/* Show component IDs as tags */}
                    <div className="flex flex-wrap gap-1">
                      {config.componentIds.map(id => (
                        <span key={id} className="px-2 py-1 bg-primary/5 text-primary rounded text-[10px] font-mono">
                          {id}
                        </span>
                      ))}
                    </div>
                    
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-md text-xs">
                      <div>
                        <span className="text-outline">Min Stock:</span>
                        <div className="font-mono text-on-surface">{config.minStockLevel}</div>
                      </div>
                      <div>
                        <span className="text-outline">Threshold:</span>
                        <div className="font-mono text-on-surface">{config.autoPOThreshold}</div>
                      </div>
                      <div>
                        <span className="text-outline">Preferred:</span>
                        <div className="font-mono text-on-surface">{config.preferredSupplier || 'Auto'}</div>
                      </div>
                      <div>
                        <span className="text-outline">Auto-Approve:</span>
                        <div className="font-mono text-on-surface">{config.autoApprove ? 'Yes' : 'No'}</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleToggle(config.id, config.enabled)}
                      className="p-2 hover:bg-surface-container rounded transition text-on-surface-variant hover:text-on-surface"
                      title={config.enabled ? 'Disable' : 'Enable'}
                    >
                      <ToggleRight className="w-4 h-4" />
                    </button>
                    <button 
                      onClick={() => handleEdit(config)}
                      className="p-2 hover:bg-surface-container rounded transition text-on-surface-variant hover:text-on-surface"
                      title="Edit"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}