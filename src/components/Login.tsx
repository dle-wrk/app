import React, { useState } from 'react';
import { LogIn, Mail, Lock, AlertCircle } from 'lucide-react';

interface LoginProps {
  onLogin: (email: string, password: string) => Promise<void>;
  isLoading?: boolean;
}

export default function Login({ onLogin, isLoading = false }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [showPassword, setShowPassword] = useState(false);

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
      <div className="w-full max-w-md">
        {/* Logo/Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center mb-4">
            <div className="w-12 h-12 bg-primary rounded-xl flex items-center justify-center">
              <LogIn className="w-6 h-6 text-on-primary" />
            </div>
          </div>
          <h1 className="text-3xl font-bold text-on-surface mb-2">Tracklab IM</h1>
          <p className="text-sm text-on-surface-variant">Enterprise Inventory Management</p>
        </div>

        {/* Login Card */}
        <div className="bg-surface-container rounded-2xl border border-outline-variant shadow-lg p-8">
          <h2 className="text-2xl font-bold text-on-surface mb-6">Sign In</h2>

          {/* Error Message */}
          {error && (
            <div className="bg-error/15 border border-error/40 rounded-lg p-4 mb-6 flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-error flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-error mb-1">Authentication Failed</p>
                <p className="text-xs text-error/90">{error}</p>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email Field */}
            <div>
              <label className="block text-sm font-bold text-on-surface mb-2">
                Email Address
              </label>
              <div className="relative">
                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-surface-container-high border border-outline-variant rounded-lg pl-10 pr-4 py-2.5 text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                  disabled={isLoading}
                />
              </div>
            </div>

            {/* Password Field */}
            <div>
              <label className="block text-sm font-bold text-on-surface mb-2">
                Password
              </label>
              <div className="relative">
                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-on-surface-variant" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="w-full bg-surface-container-high border border-outline-variant rounded-lg pl-10 pr-10 py-2.5 text-on-surface placeholder-on-surface-variant/50 focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all"
                  disabled={isLoading}
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-on-surface transition-colors"
                  disabled={isLoading}
                >
                  {showPassword ? '👁️' : '👁️‍🗨️'}
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading || !email || !password}
              className="w-full bg-primary text-on-primary py-2.5 font-bold rounded-lg hover:brightness-110 active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed transition-all mt-6 flex items-center justify-center gap-2 shadow-md shadow-primary/20"
            >
              {isLoading ? (
                <>
                  <div className="w-4 h-4 border-2 border-on-primary/30 border-t-on-primary rounded-full animate-spin" />
                  Signing in...
                </>
              ) : (
                <>
                  <LogIn className="w-5 h-5" />
                  Sign In
                </>
              )}
            </button>
          </form>

          {/* Demo Credentials */}
          <div className="mt-6 pt-6 border-t border-outline-variant">
            <p className="text-xs text-on-surface-variant mb-3">
              Demo credentials:
            </p>
            <div className="space-y-2 text-xs font-mono bg-surface-container-high p-3 rounded-lg">
              <div>
                <span className="text-on-surface-variant">Email:</span>
                <span className="text-primary ml-2">dedw13@gmail.com</span>
              </div>
              <div>
                <span className="text-on-surface-variant">Password:</span>
                <span className="text-primary ml-2">password123</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-on-surface-variant mt-6">
          © 2026 Tracklab IM • All rights reserved
        </p>
      </div>
    </div>
  );
}
