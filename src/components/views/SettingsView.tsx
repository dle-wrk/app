import React, { useState } from 'react';
import { SlidersHorizontal, Database, Check, Users, Moon, Sun, LayoutGrid } from 'lucide-react';
import { SystemConfig, UserProfile } from '../../types';
import UserManagement from '../UserManagement';

interface SettingsViewProps {
  systemConfig: SystemConfig;
  setSystemConfig: (config: SystemConfig) => void;
  setProfile: React.Dispatch<React.SetStateAction<UserProfile>>;
  TIMEZONES: { name: string; value: string }[];
  handleSaveSettings: () => void;
  isSavingSettings: boolean;
  triggerToast?: (msg: string, type?: string) => void;
}

/** Reusable toggle switch with consistent sizing and proper knob animation */
const Toggle: React.FC<{ on: boolean; onClick: () => void }> = ({ on, onClick }) => (
  <button
    onClick={onClick}
    role="switch"
    aria-checked={on}
    className={`w-9 h-5 rounded-full p-0.5 flex items-center transition-colors outline-none shrink-0 ${
      on ? 'bg-primary justify-end' : 'bg-outline-variant/60 justify-start'
    }`}
  >
    <div className="w-4 h-4 bg-white rounded-full shadow transition-transform" />
  </button>
);

export const SettingsView: React.FC<SettingsViewProps> = ({
  systemConfig,
  setSystemConfig,
  setProfile,
  TIMEZONES,
  handleSaveSettings,
  isSavingSettings,
  triggerToast = () => {}
}) => {
  const [activeTab, setActiveTab] = useState<'system' | 'users'>('system');

  const update = <K extends keyof SystemConfig>(key: K, value: SystemConfig[K]) =>
    setSystemConfig({ ...systemConfig, [key]: value });

  return (
    <div className="p-container-margin space-y-4 max-w-[1400px] mx-auto w-full select-none">
      {/* Tab Navigation */}
      <div className="flex gap-md border-b border-outline-variant">
        <button
          onClick={() => setActiveTab('system')}
          className={`px-lg py-md font-bold text-sm transition-all ${
            activeTab === 'system'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <SlidersHorizontal className="w-4 h-4 inline mr-2" />
          System Configuration
        </button>
        <button
          onClick={() => setActiveTab('users')}
          className={`px-lg py-md font-bold text-sm transition-all ${
            activeTab === 'users'
              ? 'text-primary border-b-2 border-primary'
              : 'text-on-surface-variant hover:text-on-surface'
          }`}
        >
          <Users className="w-4 h-4 inline mr-2" />
          User Management
        </button>
      </div>

      {/* System Configuration Tab */}
      {activeTab === 'system' && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-lg">
            {/* Left core system sections column */}
            <div className="md:col-span-8 space-y-4">
              {/* General System Parameters Panel */}
              <div className="bg-surface-container p-5 rounded-xl border border-outline-variant relative overflow-hidden shadow-sm">
                <h4 className="font-bold text-sm mb-5 text-primary flex items-center gap-2">
                  <SlidersHorizontal className="w-4 h-4 text-primary" />
                  General System Parameters
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-xs">
                  {/* Application Name Field */}
                  <div className="flex flex-col gap-1.5">
                    <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                      Application Name
                    </label>
                    <input
                      className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 font-mono text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all duration-150"
                      type="text"
                      value={systemConfig.appName}
                      onChange={(e) => update('appName', e.target.value)}
                    />
                  </div>

                  {/* Default Language Field */}
                  <div className="flex flex-col gap-1.5">
                    <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                      Default Language
                    </label>
                    <select
                      aria-label="Default Language"
                      className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all duration-150 cursor-pointer"
                      value={systemConfig.defaultLanguage}
                      onChange={(e) => update('defaultLanguage', e.target.value)}
                    >
                      <option>English</option>
                      <option>Deutsch</option>
                      <option>日本語</option>
                    </select>
                  </div>

                  {/* System Time Zone Field */}
                  <div className="flex flex-col gap-1.5">
                    <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                      System Time Zone
                    </label>
                    <select
                      aria-label="System Time Zone"
                      className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all duration-150 font-mono text-[11px] cursor-pointer max-w-full truncate"
                      value={systemConfig.timezone}
                      onChange={(e) => {
                        const newTz = e.target.value;
                        update('timezone', newTz);
                        setProfile(prev => ({ ...prev, timezone: newTz }));
                      }}
                    >
                      {TIMEZONES.map(tz => (
                        <option key={tz.name} value={tz.name}>{tz.name}</option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>

              {/* DB Sync configurations */}
              <div className="bg-surface-container p-lg rounded-xl border border-outline-variant">
                <h4 className="font-bold text-sm mb-lg text-primary flex items-center gap-xs">
                  <Database className="w-4 h-4" />
                  Database Synchronization Specifications
                </h4>

                <div className="space-y-md text-xs">
                  <div className="flex flex-col gap-xs">
                    <label className="font-bold text-on-surface-variant uppercase font-label-caps text-[10px]">Active connection string</label>
                    <input
                      className="bg-surface-container-high/60 border border-outline-variant rounded p-sm font-mono text-xs text-on-surface-variant select-all cursor-not-allowed outline-none"
                      type="text"
                      readOnly
                      value={systemConfig.connectionString || '— not configured —'}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-md">
                    {/* LIVE / INT switcher */}
                    <div className="p-sm rounded bg-surface-container-high border border-outline-variant flex items-center justify-between">
                      <div>
                        <span className="font-bold text-xs block text-on-surface">Data Sync stream</span>
                        <span className="text-[10px] text-on-surface-variant">Real-time tables synchronization</span>
                      </div>
                      <div className="flex p-0.5 bg-surface-container-highest border border-outline-variant rounded">
                        <button
                          onClick={() => update('syncFrequency', 'LIVE')}
                          className={`px-2 py-0.5 rounded text-[9px] font-bold transition-colors ${
                            systemConfig.syncFrequency === 'LIVE' ? 'bg-primary text-on-primary font-black' : 'text-on-surface-variant'
                          }`}
                        >
                          LIVE
                        </button>
                        <button
                          onClick={() => update('syncFrequency', 'INTV')}
                          className={`px-2 py-0.5 rounded text-[9px] font-bold transition-colors ${
                            systemConfig.syncFrequency === 'INTV' ? 'bg-primary text-on-primary font-black' : 'text-on-surface-variant'
                          }`}
                        >
                          INT
                        </button>
                      </div>
                    </div>

                    {/* Zero Stock Status toggle */}
                    <div className="p-sm rounded bg-surface-container-high border border-outline-variant flex items-center justify-between">
                      <div>
                        <span className="font-bold text-xs block text-on-surface">Zero Stock Status</span>
                        <span className="text-[10px] text-on-surface-variant">Mark out-of-stock items as alert</span>
                      </div>
                      <Toggle
                        on={systemConfig.autoStatusSync}
                        onClick={() => update('autoStatusSync', !systemConfig.autoStatusSync)}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right display parameters bento cards */}
            <div className="md:col-span-4 space-y-4 flex flex-col justify-between">
              {/* Alerts setup */}
              <div className="bg-surface-container p-lg rounded-xl border border-outline-variant">
                <h4 className="font-bold text-xs uppercase text-primary font-label-caps block mb-md">Telemetry configuration alerts</h4>
                <div className="space-y-sm text-xs">
                  <div className="flex justify-between items-center bg-surface-container-high/40 p-1.5 rounded">
                    <span className="text-on-surface-variant">Low stock alert notifications</span>
                    <Toggle
                      on={systemConfig.lowStockAlert}
                      onClick={() => update('lowStockAlert', !systemConfig.lowStockAlert)}
                    />
                  </div>
                  <div className="flex justify-between items-center bg-surface-container-high/40 p-1.5 rounded">
                    <span className="text-on-surface-variant">System latency alerts warnings</span>
                    <Toggle
                      on={systemConfig.systemLatencyWarning}
                      onClick={() => update('systemLatencyWarning', !systemConfig.systemLatencyWarning)}
                    />
                  </div>
                  <div className="flex justify-between items-center bg-surface-container-high/40 p-1.5 rounded">
                    <span className="text-on-surface-variant">Transaction summaries in ledger</span>
                    <Toggle
                      on={systemConfig.transactionSummaries}
                      onClick={() => update('transactionSummaries', !systemConfig.transactionSummaries)}
                    />
                  </div>
                </div>
              </div>

              {/* Interface Layout theme switches */}
              <div className="bg-surface-container p-lg rounded-xl border border-outline-variant">
                <h4 className="font-bold text-xs uppercase text-primary font-label-caps block mb-md">Custom display theme styling</h4>
                <div className="grid grid-cols-2 gap-sm text-[10px] select-none text-center">
                  <button
                    onClick={() => update('visualTheme', 'dark')}
                    className={`p-md rounded border flex flex-col items-center gap-xs transition-colors ${
                      systemConfig.visualTheme === 'dark'
                        ? 'border-primary bg-primary/10 text-primary font-bold'
                        : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    <Moon className="w-4 h-4 text-primary" />
                    <span>DARK COBALT FIRST</span>
                  </button>
                  <button
                    onClick={() => update('visualTheme', 'light')}
                    className={`p-md rounded border flex flex-col items-center gap-xs transition-colors ${
                      systemConfig.visualTheme === 'light'
                        ? 'border-primary bg-primary/10 text-primary font-bold'
                        : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-high'
                    }`}
                  >
                    <Sun className="w-4 h-4 text-primary" />
                    <span>PRISTINE BRIGHT LIGHT</span>
                  </button>
                </div>

                {/* High density mode toggle */}
                <div className="flex justify-between items-center mt-md pt-md border-t border-outline-variant/50">
                  <div className="flex items-center gap-1.5">
                    <LayoutGrid className="w-3.5 h-3.5 text-on-surface-variant" />
                    <span className="text-xs text-on-surface-variant">High-density layout mode</span>
                  </div>
                  <Toggle
                    on={systemConfig.highDensityMode}
                    onClick={() => update('highDensityMode', !systemConfig.highDensityMode)}
                  />
                </div>
              </div>

              <button
                onClick={handleSaveSettings}
                disabled={isSavingSettings}
                className="bg-primary text-on-primary py-sm font-bold text-xs tracking-wide rounded-lg hover:brightness-115 active:scale-95 transition-all text-center flex items-center justify-center gap-2 shadow disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Check className="w-4 h-4" />
                {isSavingSettings ? 'Syncing DB configurations...' : 'Save System configurations'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* User Management Tab */}
      {activeTab === 'users' && (
        <div className="bg-surface-container rounded-xl border border-outline-variant p-lg">
          <UserManagement triggerToast={triggerToast} />
        </div>
      )}
    </div>
  );
};