import React, { useState } from 'react';
import { KeyRound, Lock, AlertCircle, CheckCircle2, Eye, EyeOff } from 'lucide-react';

interface ResetPasswordProps {
  token: string;
  onSuccess: () => void;
}

// Landing view for password-reset links. Reads the token from the URL query
// string upstream and hands it here; on success clears the URL and returns
// the user to the login screen with a toast.
export default function ResetPassword({ token, onSuccess }: ResetPasswordProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const canSubmit = password.length >= 8 && password === confirm;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 8) return setError('Password must be at least 8 characters');
    if (password !== confirm) return setError('Passwords do not match');
    setSubmitting(true);
    try {
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not reset password');
      setDone(true);
    } catch (err: any) {
      setError(err.message || 'Could not reset password');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary via-surface to-surface-container flex items-center justify-center p-4">
      <div className="w-full max-w-[384px] md:max-w-[448px]">
        <div className="text-center mb-12">
          <div className="flex items-center justify-center mb-6">
            <div className="w-14 h-14 bg-primary/20 rounded-2xl flex items-center justify-center border border-primary/40">
              <KeyRound className="w-8 h-8 text-primary" />
            </div>
          </div>
          <h1 className="text-4xl font-black text-on-surface mb-2 tracking-tight">Tracklab IM</h1>
          <p className="text-sm text-on-surface-variant/80 font-medium">Choose a new password</p>
        </div>

        <div className="bg-surface-container rounded-2xl border border-outline-variant shadow-2xl p-8 space-y-6">
          {done ? (
            <div className="bg-primary/10 border border-primary/30 rounded-xl p-4 flex items-start gap-3">
              <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-primary">Password updated</p>
                <p className="text-xs text-on-surface-variant mt-1">
                  All previous sessions have been signed out. Sign in with your new password.
                </p>
                <button onClick={onSuccess} className="text-xs text-primary font-bold mt-3 hover:underline">
                  Go to sign in →
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <h2 className="text-2xl font-bold text-on-surface">Reset password</h2>
                <p className="text-xs text-on-surface-variant mt-1">
                  Choose a strong password. All sessions on this account will be signed out.
                </p>
              </div>

              {error && (
                <div className="bg-error/20 border border-error/50 rounded-xl p-4 flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm font-bold text-error">Reset failed</p>
                    <p className="text-xs text-error/80 mt-1">{error}</p>
                  </div>
                </div>
              )}

              <form onSubmit={handleSubmit} className="space-y-5">
                <div>
                  <label className="block text-xs font-bold text-on-surface mb-2 uppercase tracking-wider">New password</label>
                  <div className="relative rounded-lg border-2 border-outline-variant/50 bg-surface-container-high focus-within:border-primary transition-colors">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="At least 8 characters"
                      autoComplete="new-password"
                      disabled={submitting}
                      className="w-full bg-transparent outline-none pl-10 pr-12 py-3 text-on-surface placeholder-on-surface-variant/50 text-sm font-medium"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface p-1"
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                    >
                      {showPassword ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-bold text-on-surface mb-2 uppercase tracking-wider">Confirm password</label>
                  <div className="relative rounded-lg border-2 border-outline-variant/50 bg-surface-container-high focus-within:border-primary transition-colors">
                    <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant" />
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      placeholder="Retype it"
                      autoComplete="new-password"
                      disabled={submitting}
                      className="w-full bg-transparent outline-none pl-10 pr-4 py-3 text-on-surface placeholder-on-surface-variant/50 text-sm font-medium"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={submitting || !canSubmit}
                  className="w-full bg-primary text-on-primary py-3 font-bold text-sm rounded-lg hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-primary/30 uppercase tracking-wider"
                >
                  {submitting ? (
                    <>
                      <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
                      Updating
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-5 h-5" />
                      Update password
                    </>
                  )}
                </button>
              </form>
            </>
          )}
        </div>

        <p className="text-center text-xs text-on-surface-variant/60 mt-8">© 2026 Tracklab IM • All rights reserved</p>
      </div>
    </div>
  );
}
