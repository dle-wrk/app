import React, { useState } from 'react';
import { LogIn, Mail, Lock, AlertCircle, Eye, EyeOff, KeyRound, CheckCircle2, ArrowLeft } from 'lucide-react';

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  isLoading?: boolean;
}

type Mode = 'login' | 'forgot';

export default function Login({ onLogin, isLoading = false }: LoginProps) {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);
  const [forgotSubmitting, setForgotSubmitting] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!email || !password) {
      setError('Email and password are required');
      return;
    }

    try {
      await onLogin(email, password);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!email) {
      setError('Enter your email to request a reset');
      return;
    }
    setForgotSubmitting(true);
    try {
      // Always shows the same success message regardless of whether the
      // email is registered — the server does the same for security.
      const res = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok && res.status !== 429) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Could not send reset link');
      }
      if (res.status === 429) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Too many attempts — please wait a while.');
      }
      setForgotSent(true);
    } catch (err: any) {
      setError(err.message || 'Could not send reset link');
    } finally {
      setForgotSubmitting(false);
    }
  };

  const goToLogin = () => {
    setMode('login');
    setForgotSent(false);
    setError('');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary via-surface to-surface-container flex items-center justify-center p-4">
      {/* Arbitrary values, not max-w-sm/md: those resolve to --spacing-sm/md
          (8px/16px) in this theme. The previous inline style masked that but
          also forced 448px at every breakpoint, defeating the responsive step. */}
      <div className="w-full max-w-[384px] md:max-w-[448px]">
        {/* Logo/Header */}
        <div className="text-center mb-12">
          <div className="flex items-center justify-center mb-6">
            <div className="w-14 h-14 bg-primary/20 rounded-2xl flex items-center justify-center border border-primary/40">
              <LogIn className="w-8 h-8 text-primary" />
            </div>
          </div>
          <h1 className="text-4xl font-black text-on-surface mb-2 tracking-tight">Tracklab IM</h1>
          <p className="text-sm text-on-surface-variant/80 font-medium">Enterprise Inventory Management System</p>
        </div>

        {/* Login Card */}
        <div className="bg-surface-container rounded-2xl border border-outline-variant shadow-2xl p-8 space-y-6">
          <div>
            <h2 className="text-2xl font-bold text-on-surface">
              {mode === 'login' ? 'Welcome Back' : 'Forgot password'}
            </h2>
            <p className="text-xs text-on-surface-variant mt-1">
              {mode === 'login'
                ? 'Sign in to your account to continue'
                : forgotSent
                  ? 'Check your inbox for a reset link.'
                  : 'Enter your email — we\'ll send a reset link if the account exists.'}
            </p>
          </div>

          {/* Error Message. Heading distinguishes a real "wrong credentials"
              from a "service can't reach the DB" so operators (and users) can
              tell at a glance whether the problem is on their end. */}
          {error && (() => {
            const isServiceIssue = /database|unavailable|network|try again/i.test(error);
            return (
              <div className="bg-error/20 border border-error/50 rounded-xl p-4 flex items-start gap-3 animate-pulse">
                <AlertCircle className="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-error">
                    {isServiceIssue ? 'Service Unavailable' : 'Authentication Failed'}
                  </p>
                  <p className="text-xs text-error/80 mt-1">{error}</p>
                </div>
              </div>
            );
          })()}

          {mode === 'forgot' ? (
            forgotSent ? (
              <div className="bg-primary/10 border border-primary/30 rounded-xl p-4 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-bold text-primary">Reset link sent</p>
                  <p className="text-xs text-on-surface-variant mt-1">
                    If <span className="font-mono">{email}</span> is registered, a reset link is on its way.
                    The link is valid for 30 minutes. Check your spam folder if you don't see it.
                  </p>
                  <button type="button" onClick={goToLogin} className="text-xs text-primary font-bold mt-3 flex items-center gap-1 hover:underline">
                    <ArrowLeft className="w-3 h-3" /> Back to sign in
                  </button>
                </div>
              </div>
            ) : (
              <form onSubmit={handleForgotSubmit} className="space-y-5">
                <div>
                  <label className="block text-xs font-bold text-on-surface mb-2 uppercase tracking-wider">Email Address</label>
                  <div className={`relative rounded-lg border-2 transition-all ${focused === 'email' ? 'border-primary bg-surface-container-high/50' : 'border-outline-variant/50 bg-surface-container-high'}`}>
                    <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 ${focused === 'email' ? 'text-primary' : 'text-on-surface-variant'}`} />
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} onFocus={() => setFocused('email')} onBlur={() => setFocused(null)} placeholder="name@example.com" autoComplete="email" disabled={forgotSubmitting} className="w-full bg-transparent outline-none pl-10 pr-4 py-3 text-on-surface placeholder-on-surface-variant/50 text-sm font-medium" />
                  </div>
                </div>
                <button type="submit" disabled={forgotSubmitting || !email} className="w-full bg-primary text-on-primary py-3 font-bold text-sm rounded-lg hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2 shadow-lg shadow-primary/30 uppercase tracking-wider">
                  {forgotSubmitting ? (
                    <><div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />Sending</>
                  ) : (
                    <><KeyRound className="w-5 h-5" />Send reset link</>
                  )}
                </button>
                <button type="button" onClick={goToLogin} className="w-full text-xs text-on-surface-variant hover:text-on-surface flex items-center justify-center gap-1">
                  <ArrowLeft className="w-3 h-3" /> Back to sign in
                </button>
              </form>
            )
          ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Email Field */}
            <div>
              <label className="block text-xs font-bold text-on-surface mb-2 uppercase tracking-wider">
                Email Address
              </label>
              <div className={`relative rounded-lg border-2 transition-all ${
                focused === 'email'
                  ? 'border-primary bg-surface-container-high/50'
                  : 'border-outline-variant/50 bg-surface-container-high'
              }`}>
                <Mail className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 transition-colors ${
                  focused === 'email' ? 'text-primary' : 'text-on-surface-variant'
                }`} />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => setFocused('email')}
                  onBlur={() => setFocused(null)}
                  placeholder="name@example.com"
                  className="w-full bg-transparent outline-none pl-10 pr-4 py-3 text-on-surface placeholder-on-surface-variant/50 text-sm font-medium"
                  disabled={isLoading}
                  autoComplete="email"
                />
              </div>
            </div>

            {/* Password Field */}
            <div>
              <label className="block text-xs font-bold text-on-surface mb-2 uppercase tracking-wider">
                Password
              </label>
              <div className={`relative rounded-lg border-2 transition-all ${
                focused === 'password'
                  ? 'border-primary bg-surface-container-high/50'
                  : 'border-outline-variant/50 bg-surface-container-high'
              }`}>
                <Lock className={`absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 transition-colors ${
                  focused === 'password' ? 'text-primary' : 'text-on-surface-variant'
                }`} />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocused('password')}
                  onBlur={() => setFocused(null)}
                  placeholder="••••••••"
                  className="w-full bg-transparent outline-none pl-10 pr-12 py-3 text-on-surface placeholder-on-surface-variant/50 text-sm font-medium"
                  disabled={isLoading}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors p-1"
                  disabled={isLoading}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                >
                  {showPassword ? <Eye className="w-5 h-5" /> : <EyeOff className="w-5 h-5" />}
                </button>
              </div>
            </div>

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => { setMode('forgot'); setError(''); }}
                className="text-xs text-on-surface-variant hover:text-primary transition-colors"
                disabled={isLoading}
              >
                Forgot password?
              </button>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="w-full bg-primary text-on-primary py-3 font-bold text-sm rounded-lg hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all mt-2 flex items-center justify-center gap-2 shadow-lg shadow-primary/30 uppercase tracking-wider"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
                  Signing In
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  Sign In
                </>
              )}
            </button>
          </form>
          )}

        </div>

        {/* Footer */}
        <p className="text-center text-xs text-on-surface-variant/60 mt-8">
          © 2026 Tracklab IM • All rights reserved
        </p>
      </div>
    </div>
  );
}
