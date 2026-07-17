import React, { useState } from 'react';
import { SlidersHorizontal, X, Check, Boxes } from 'lucide-react';
import { UserProfile, SystemConfig } from '../../types';

interface ProfileViewProps {
  profile: UserProfile;
  setProfile: React.Dispatch<React.SetStateAction<UserProfile>>;
  systemConfig: SystemConfig;
  setSystemConfig: (config: SystemConfig) => void;
  TIMEZONES: { name: string; value: string }[];
  triggerToast: (msg: string) => void;
  handleStockSync: () => void;
}

export const ProfileView: React.FC<ProfileViewProps> = ({
  profile,
  setProfile,
  systemConfig,
  setSystemConfig,
  TIMEZONES,
  triggerToast,
  handleStockSync
}) => {
  const [isEditingProfile, setIsEditingProfile] = useState<boolean>(false);
  const [localForm, setLocalForm] = useState<UserProfile | null>(null);

  const enterEditMode = () => {
    setLocalForm({ ...profile });
    setIsEditingProfile(true);
  };

  return (
    <div className="p-6 space-y-6 max-w-[1250px] mx-auto w-full select-none">
      {/* Profile Header Block */}
      <div className="flex flex-col sm:flex-row justify-between sm:items-center gap-4 bg-surface-container p-5 rounded-xl border border-outline-variant/70 shadow-sm">
        <div>
          <h3 className="text-lg text-on-surface font-bold tracking-tight">User Identity Profile</h3>
          <p className="text-on-surface-variant text-[11px] mt-0.5">
            Manage your administrative system credentials and localization parameters.
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            if (isEditingProfile) {
              setIsEditingProfile(false);
              setLocalForm(null);
            } else {
              enterEditMode();
            }
          }}
          className="flex items-center justify-center gap-2 bg-primary/15 text-primary hover:bg-primary/25 border border-primary/30 px-4 py-2 rounded-lg text-xs font-bold transition-all shrink-0 cursor-pointer active:scale-95"
        >
          {isEditingProfile ? (
            <>
              <X className="w-3.5 h-3.5" aria-label="Close" />
              Cancel Editing
            </>
          ) : (
            <>
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Edit User Profile
            </>
          )}
        </button>
      </div>

      {isEditingProfile && localForm ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setProfile(localForm);
            setIsEditingProfile(false);

            fetch('/api/settings', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ profile: localForm }),
            }).catch(err => console.error('Failed to save profile:', err));

            triggerToast("User profile details successfully saved & active!");
          }}
          className="bg-surface-container border border-outline-variant p-6 rounded-xl space-y-6 shadow-md animate-fade-in"
        >
          <h4 className="font-bold text-xs uppercase text-primary font-mono tracking-wider flex items-center gap-2 border-b border-outline-variant/30 pb-3">
            <SlidersHorizontal className="w-4 h-4 text-primary shrink-0" />
            Modify Inventory Account Parameters
          </h4>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Full Name</label>
              <input
                required
                type="text"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs transition-all"
                value={localForm.name}
                onChange={(e) => setLocalForm({ ...localForm, name: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Administrative Email</label>
              <input
                required
                type="email"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs transition-all"
                value={localForm.email}
                onChange={(e) => setLocalForm({ ...localForm, email: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Operations Role / Title</label>
              <input
                required
                type="text"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs transition-all"
                value={localForm.role}
                onChange={(e) => setLocalForm({ ...localForm, role: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Operations ID (OP-ID)</label>
              <input
                required
                type="text"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs transition-all"
                value={localForm.opId}
                onChange={(e) => setLocalForm({ ...localForm, opId: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Clearance Standard Level</label>
              <select aria-label="Filter"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 text-xs font-mono transition-all cursor-pointer"
                value={localForm.clearanceLevel}
                onChange={(e) => setLocalForm({ ...localForm, clearanceLevel: Number(e.target.value) })}
              >
                <option value="1">Clearance Level 1 (Basic)</option>
                <option value="2">Clearance Level 2 (Intermediate)</option>
                <option value="3">Clearance Level 3 (Advance)</option>
                <option value="4">Clearance Level 4 (Standard Lead)</option>
                <option value="5">Clearance Level 5 (Root Control)</option>
              </select>
            </div>

            <div className="flex flex-col gap-1.5">
              <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Localization Time Zone</label>
              <select aria-label="Filter"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2.5 text-on-surface outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 font-mono text-xs transition-all cursor-pointer"
                value={localForm.timezone}
                onChange={(e) => {
                  const newTz = e.target.value;
                  setLocalForm({ ...localForm, timezone: newTz });
                  setSystemConfig({ ...systemConfig, timezone: newTz });
                }}
              >
                {TIMEZONES.map(tz => (
                  <option key={tz.name} value={tz.name}>{tz.name}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-3 bg-surface-container-low border border-outline-variant/60 p-4 rounded-xl">
            <span className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider block">Profile Representative Avatar</span>
            <div className="flex flex-wrap items-center gap-3">
              {[
                { name: 'Alex', url: 'https://lh3.googleusercontent.com/aida-public/AB6AXuD0_EYGPOE6kTvh7y2delA9HonD0T7oWPUppR8ZSXEaOciXPkCacuJ0pqCHkeWDEe19lPJwuSKU_cN3LEGUKuhGesoPz4KXoLh-ay0p_1OxYur0IP-e8NpeCzB8VUDXMs0K2i014V73ZbQvkpioC98lBifcXbNv0kRGn5iWAI_cJSd2HdRqt0tyYWAZtVe4YAmUyQwwnq-LbvxLYQB9-KWZN1xBFX9ImCue1HyaUYtO-liGB266NP5EVAVa1c8HFwaW1_j3wVnJ7mc' },
                { name: 'Ops Team', url: 'https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?auto=format&fit=crop&q=80&w=150&h=150' },
                { name: 'Manager', url: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&q=80&w=150&h=150' },
                { name: 'Logistics', url: 'https://images.unsplash.com/photo-1628157582853-a796fa650a6a?auto=format&fit=crop&q=80&w=150&h=150' }
              ].map(av => (
                <button
                  type="button"
                  key={av.url}
                  onClick={() => setLocalForm({ ...localForm, avatarUrl: av.url })}
                  className={`relative w-12 h-12 rounded-xl overflow-hidden border-2 transition-all cursor-pointer ${localForm.avatarUrl === av.url ? 'border-primary ring-2 ring-primary/40 scale-105' : 'border-outline-variant hover:border-outline/80'
                    }`}
                >
                  <img
                    src={av.url}
                    alt={av.name}
                    className="w-full h-full object-cover animate-fade-in"
                    referrerPolicy="no-referrer"
                    onError={(e) => {
                      e.currentTarget.src = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=facearea&facepad=2&w=256&h=256&q=80";
                    }}
                  />
                </button>
              ))}
            </div>
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-[10px] text-on-surface-variant/80 font-mono">Or enter custom Image avatar URL:</span>
              <input
                type="text"
                className="bg-surface-container-high border border-outline-variant rounded-lg p-2 text-on-surface outline-none focus:border-primary font-mono text-xs w-full transition-all"
                value={localForm.avatarUrl}
                onChange={(e) => setLocalForm({ ...localForm, avatarUrl: e.target.value })}
              />
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <label className="font-bold text-on-surface-variant uppercase font-mono text-[10px] tracking-wider">Administrative Bio Description</label>
            <textarea
              rows={3}
              className="bg-surface-container-high border border-outline-variant rounded-lg p-3 text-on-surface outline-none focus:border-primary font-sans text-xs w-full resize-none transition-all"
              value={localForm.bio}
              onChange={(e) => setLocalForm({ ...localForm, bio: e.target.value })}
            />
          </div>

          <div className="flex justify-end pt-2 border-t border-outline-variant/30">
            <button
              type="submit"
              className="bg-primary text-on-primary hover:brightness-110 font-bold px-5 py-2.5 rounded-lg text-xs tracking-wider flex items-center gap-2 shadow active:scale-95 transition-all cursor-pointer"
            >
              <Check className="w-4 h-4 shrink-0" />
              Apply & Save Profile Changes
            </button>
          </div>
        </form>
      ) : (
        <>
          <div className="bg-surface-container border border-outline-variant p-6 rounded-xl flex flex-col md:flex-row items-center gap-6 relative overflow-hidden shadow-sm shadow-black/10">
            <div className="absolute right-0 top-0 w-1/2 h-full opacity-[0.03] pointer-events-none">
              <Boxes className="w-64 h-64 text-primary translate-x-12 -translate-y-4" />
            </div>

            <div className="w-24 h-24 rounded-2xl overflow-hidden border-2 border-primary/40 relative shrink-0 shadow-inner bg-surface-container-high">
              <img
                className="w-full h-full object-cover animate-fade-in"
                src={profile.avatarUrl}
                alt={`${profile.name} ${profile.role}`}
                referrerPolicy="no-referrer"
                onError={(e) => {
                  e.currentTarget.src = "https://images.unsplash.com/photo-1472099645785-5658abf4ff4e?auto=format&fit=facearea&facepad=2&w=256&h=256&q=80";
                }}
              />
            </div>

            <div className="flex-1 text-center md:text-left space-y-1.5">
              <h3 className="text-xl font-bold text-on-surface">{profile.name}</h3>
              <p className="text-primary text-xs font-semibold font-mono tracking-wider">
                {profile.role} • OP-ID: {profile.opId} • Clearance Standard Level {profile.clearanceLevel}
              </p>
              <p className="text-on-surface-variant text-xs max-w-[576px] leading-relaxed pt-1">
                {profile.bio || "No administrative biographical description registered for this operations terminal agent account."}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="bg-surface-container p-6 border border-outline-variant rounded-xl text-xs space-y-3.5 shadow-sm">
              <h4 className="font-bold text-sm text-primary mb-2 flex items-center gap-2">
                System Metadata and Metrics
              </h4>
              <div className="flex justify-between items-center border-b border-outline-variant/30 pb-2">
                <span className="text-on-surface-variant">Primary System Language</span>
                <span className="font-semibold text-on-surface">English (US)</span>
              </div>
              <div className="flex justify-between items-center border-b border-outline-variant/30 pb-2">
                <span className="text-on-surface-variant">Administrative Email</span>
                <span className="font-bold font-mono text-on-surface">{profile.email}</span>
              </div>
              <div className="flex justify-between items-center border-b border-outline-variant/30 pb-2">
                <span className="text-on-surface-variant">System Timezone Setting</span>
                <span className="font-bold font-mono text-on-surface">{profile.timezone}</span>
              </div>
              <div className="flex justify-between items-center pt-0.5">
                <span className="text-on-surface-variant">Core Terminal Database Connection</span>
                <span className="font-bold text-green-400 font-mono bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 text-[11px]">
                  sqlite_v3_secure
                </span>
              </div>
            </div>

            <div className="bg-surface-container p-6 border border-outline-variant rounded-xl text-xs flex flex-col justify-between shadow-sm gap-4">
              <div className="space-y-2">
                <h4 className="font-bold text-sm text-secondary flex items-center gap-2">
                  Diagnostic System Credentials
                </h4>
                <p className="text-on-surface-variant leading-relaxed text-[11px]">
                  Diag credentials are synchronized periodically with external hubs. In case of a network outage, fallback local tables will be referenced automatically.
                </p>
              </div>
              <button
                type="button"
                onClick={handleStockSync}
                className="bg-surface-container-high hover:bg-surface-container-highest border border-outline-variant py-2.5 rounded-lg text-xs px-4 font-bold text-center w-full transition-colors cursor-pointer active:scale-[0.98]"
              >
                Audit Session Integrity Token
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};