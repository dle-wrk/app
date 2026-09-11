import React, { useState } from 'react';
import { ShieldAlert, Eye, EyeOff, CheckCircle2 } from 'lucide-react';

// Non-dismissable modal shown after login when the server flagged
// mustChangePassword=true. Deliberately no X button, no backdrop click,
// no Escape close — the user cannot proceed to the app until they pick
// a real password. This is the reason the flow exists.
//
// The one escape hatch is signing out (button at the bottom): a user
// who's landed here at a wrong machine can back out cleanly.

interface Props {
  currentPassword?: string;  // pre-filled with what the user just typed to log in
  onSubmit: (currentPassword: string, newPassword: string) => Promise<void>;
  onSignOut: () => void;
}

export default function MustChangePasswordModal({ currentPassword: prefilled, onSubmit, onSignOut }: Props) {
  const [currentPassword, setCurrentPassword] = useState(prefilled || '');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rules = [
    { ok: newPassword.length >= 8, text: 'At least 8 characters' },
    { ok: newPassword.trim().toLowerCase() !== 'tracklab' && newPassword.length > 0, text: 'Not the default "tracklab"' },
    { ok: newPassword.length > 0 && newPassword === confirmPassword, text: 'Both fields match' },
    { ok: newPassword.length > 0 && newPassword !== currentPassword, text: 'Different from the current password' },
  ];
  const allOk = rules.every(r => r.ok);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!allOk) return;
    setSubmitting(true);
    try {
      await onSubmit(currentPassword, newPassword);
      // Parent removes the modal on success; nothing else to do here.
    } catch (err: any) {
      setError(err?.message || 'Failed to change password');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[300] bg-background/90 backdrop-blur-sm flex items-center justify-center p-md"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="bg-surface-container rounded-xl border border-outline-variant max-w-[480px] w-full shadow-2xl">
        <div className="px-lg py-md border-b border-outline-variant flex items-center gap-sm bg-primary/5">
          <ShieldAlert className="w-5 h-5 text-primary" />
          <div>
            <h3 className="font-bold text-sm text-on-surface">Set a new password</h3>
            <p className="text-[10px] text-outline mt-0.5">Your account is on the temporary default. Choose a real one to continue.</p>
          </div>
        </div>

        <form onSubmit={submit} className="px-lg py-md space-y-md">
          <div>
            <label className="block text-xs font-bold text-outline uppercase mb-1">Current password</label>
            <input
              type="password"
              autoComplete="current-password"
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm focus:outline-none focus:border-primary"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder='"tracklab" if this is your first login'
              required
            />
          </div>

          <div>
            <label className="block text-xs font-bold text-outline uppercase mb-1">New password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                autoComplete="new-password"
                className="w-full px-3 py-2 pr-10 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm focus:outline-none focus:border-primary"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                minLength={8}
                maxLength={200}
              />
              <button
                type="button"
                onClick={() => setShowNew(s => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-outline hover:text-on-surface p-1"
                title={showNew ? 'Hide' : 'Show'}
              >
                {showNew ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
              </button>
            </div>
          </div>

          <div>
            <label className="block text-xs font-bold text-outline uppercase mb-1">Confirm new password</label>
            <input
              type={showNew ? 'text' : 'password'}
              autoComplete="new-password"
              className="w-full px-3 py-2 rounded border border-outline-variant bg-surface-container-low text-on-surface text-sm focus:outline-none focus:border-primary"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>

          <ul className="space-y-1 text-[11px]">
            {rules.map((r, i) => (
              <li key={i} className={`flex items-center gap-2 ${r.ok ? 'text-green-400' : 'text-outline'}`}>
                <CheckCircle2 className={`w-3 h-3 ${r.ok ? 'opacity-100' : 'opacity-30'}`} />
                {r.text}
              </li>
            ))}
          </ul>

          {error && (
            <div className="p-2 rounded bg-error/10 border border-error/30 text-error text-xs">
              {error}
            </div>
          )}

          <div className="flex items-center justify-between gap-sm pt-sm border-t border-outline-variant/30">
            <button
              type="button"
              onClick={onSignOut}
              className="text-[11px] text-outline hover:text-on-surface underline"
              title="Sign out without setting a password"
            >
              Not you? Sign out
            </button>
            <button
              type="submit"
              disabled={!allOk || submitting}
              className="px-4 py-2 rounded-lg bg-primary text-on-primary text-xs font-bold hover:brightness-110 active:scale-95 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {submitting ? 'Saving…' : 'Set new password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
