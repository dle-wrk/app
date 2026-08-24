import React, { useState } from 'react';
import { LogIn, Mail, Lock, AlertCircle, Eye, EyeOff } from 'lucide-react';

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  isLoading?: boolean;
}

export default function Login({ onLogin, isLoading = false }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [focused, setFocused] = useState<string | null>(null);

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
            <h2 className="text-2xl font-bold text-on-surface">Welcome Back</h2>
            <p className="text-xs text-on-surface-variant mt-1">Sign in to your account to continue</p>
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

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="w-full bg-primary text-on-primary py-3 font-bold text-sm rounded-lg hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all mt-8 flex items-center justify-center gap-2 shadow-lg shadow-primary/30 uppercase tracking-wider"
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

        </div>

        {/* Footer */}
        <p className="text-center text-xs text-on-surface-variant/60 mt-8">
          © 2026 Tracklab IM • All rights reserved
        </p>
      </div>
    </div>
  );
}
