import React from 'react';
import { SlidersHorizontal, Database, HelpCircle, Check } from 'lucide-react';
import { SystemConfig, UserProfile } from '../../types';

interface SettingsViewProps {
  systemConfig: SystemConfig;
  setSystemConfig: (config: SystemConfig) => void;
  setProfile: React.Dispatch<React.SetStateAction<UserProfile>>;
  TIMEZONES: { name: string; value: string }[];
  handleSaveSettings: () => void;
  isSavingSettings: boolean;
}

export const SettingsView: React.FC<SettingsViewProps> = ({
  systemConfig,
  setSystemConfig,
  setProfile,
  TIMEZONES,
  handleSaveSettings,
  isSavingSettings
}) => {
  return (
    <div className="p-container-margin space-y-4 max-w-[1200px] mx-auto w-full select-none">
      {/* Core configs form */}
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
                  onChange={(e) => setSystemConfig({ ...systemConfig, appName: e.target.value })}
                />
              </div>

              {/* Default Language Field */}
              <div className="flex flex-col gap-1.5">
                <label className="font-bold text-on-surface-variant/80 uppercase tracking-wider text-[10px]">
                  Default Language
                </label>
                <select aria-label="Filter"
                  className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-xs text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all duration-150 cursor-pointer"
                  value={systemConfig.defaultLanguage}
                  onChange={(e) => setSystemConfig({ ...systemConfig, defaultLanguage: e.target.value })}
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
                <select aria-label="Filter"
                  className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-1 focus:ring-primary/20 transition-all duration-150 font-mono text-[11px] cursor-pointer max-w-full truncate"
                  value={systemConfig.timezone}
                  onChange={(e) => {
                    const newTz = e.target.value;
                    setSystemConfig({ ...systemConfig, timezone: newTz });
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
                <label className="font-bold text-outline uppercase font-label-caps text-[10px]">Active connection string</label>
                <input
                  className="bg-surface-container-high/60 border border-outline-variant rounded p-sm font-mono text-outline-variant select-all cursor-not-allowed outline-none"
                  type="text"
                  readOnly
                  value={systemConfig.connectionString}
                />
              </div>

              <div className="grid grid-cols-2 gap-md">
                {/* LIVE switcher */}
                <div className="p-sm rounded bg-surface-container-high border border-outline-variant flex items-center justify-between">
                  <div>
                    <span className="font-bold text-xs block text-on-surface">Data Sync stream</span>
                    <span className="text-[10px] text-outline">Real-time tables synchronization</span>
                  </div>
                  <div className="flex p-0.5 bg-surface-container-highest border border-outline-variant rounded">
                    <button
                      onClick={() => setSystemConfig({ ...systemConfig, syncFrequency: 'LIVE' })}
                      className={`px-2 py-0.5 rounded text-[9px] font-bold ${systemConfig.syncFrequency === 'LIVE' ? 'bg-primary text-on-primary font-black' : 'text-on-surface-variant'
                        }`}
                    >
                      LIVE
                    </button>
                    <button
                      onClick={() => setSystemConfig({ ...systemConfig, syncFrequency: 'LIVE' })}
                      className="px-2 py-0.5 rounded text-[9px] font-bold text-on-surface-variant"
                    >
                      INT
                    </button>
                  </div>
                </div>

                {/* Switch status */}
                <div className="p-sm rounded bg-surface-container-high border border-outline-variant flex items-center justify-between">
                  <div>
                    <span className="font-bold text-xs block text-on-surface font-sans">Zero Stock Status</span>
                    <span className="text-[10px] text-outline">Mark out-of-stock items as alert</span>
                  </div>
                  <button
                    onClick={() => setSystemConfig({ ...systemConfig, autoStatusSync: !systemConfig.autoStatusSync })}
                    className={`w-10 h-5 rounded-full p-0.5 transition-all outline-none ${systemConfig.autoStatusSync ? 'bg-primary justify-end text-right' : 'bg-outline-variant/60'
                      }`}
                  >
                    <div className="w-4 h-4 bg-white rounded-full inline-block shadow"></div>
                  </button>
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
                <button
                  onClick={() => setSystemConfig({ ...systemConfig, lowStockAlert: !systemConfig.lowStockAlert })}
                  className={`w-8 h-4 rounded-full p-0.5 transition-colors ${systemConfig.lowStockAlert ? 'bg-primary' : 'bg-outline-variant/60'}`}
                >
                  <div className="w-3 h-3 bg-white rounded-full"></div>
                </button>
              </div>
              <div className="flex justify-between items-center bg-surface-container-high/40 p-1.5 rounded">
                <span className="text-on-surface-variant">System latency alerts warnings</span>
                <button
                  onClick={() => setSystemConfig({ ...systemConfig, systemLatencyWarning: !systemConfig.systemLatencyWarning })}
                  className={`w-8 h-4 rounded-full p-0.5 transition-colors ${systemConfig.systemLatencyWarning ? 'bg-primary' : 'bg-outline-variant/60'}`}
                >
                  <div className="w-3 h-3 bg-white rounded-full"></div>
                </button>
              </div>
            </div>
          </div>

          {/* Interface Layout theme switches */}
          <div className="bg-surface-container p-lg rounded-xl border border-outline-variant">
            <h4 className="font-bold text-xs uppercase text-primary font-label-caps block mb-md">Custom display theme styling</h4>
            <div className="grid grid-cols-2 gap-sm text-[10px] select-none text-center">
              <button
                onClick={() => setSystemConfig({ ...systemConfig, visualTheme: 'dark' })}
                className={`p-md rounded border flex flex-col items-center gap-xs ${systemConfig.visualTheme === 'dark'
                  ? 'border-primary bg-primary/10 text-primary font-bold'
                  : 'border-outline-variant text-outline hover:bg-surface-container-high'
                  }`}
              >
                <Database className="w-4 h-4 text-primary" />
                <span>DARK COBALT FIRST</span>
              </button>
              <button
                onClick={() => setSystemConfig({ ...systemConfig, visualTheme: 'light' })}
                className={`p-md rounded border flex flex-col items-center gap-xs ${systemConfig.visualTheme === 'light'
                  ? 'border-primary bg-primary/10 text-primary font-bold'
                  : 'border-outline-variant text-outline hover:bg-surface-container-high'
                  }`}
              >
                <HelpCircle className="w-4 h-4 text-primary" />
                <span>PRISTINE BRIGHT LIGHT</span>
              </button>
            </div>
          </div>

          <button
            onClick={handleSaveSettings}
            disabled={isSavingSettings}
            className="bg-primary text-on-primary py-sm font-bold text-xs tracking-wide rounded-lg hover:brightness-115 active:scale-95 transition-all text-center flex items-center justify-center gap-2 shadow"
          >
            <Check className="w-4 h-4" />
            {isSavingSettings ? 'Syncing DB configurations...' : 'Save System configurations'}
          </button>
        </div>
      </div>
    </div>
  );
};