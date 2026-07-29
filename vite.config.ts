import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';
import { readFileSync } from 'fs';
import { spawn, execSync } from 'child_process';

// Single source of truth for the app version: package.json. The sidebar badge
// used to hard-code "v2.5.0-PRO" while package.json said 0.0.0, so the two
// could (and did) drift apart.
const pkgVersion = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version;

export default defineConfig(() => {
  return {
    define: {
      __APP_VERSION__: JSON.stringify(pkgVersion),
    },
    plugins: [
      react(),
      tailwindcss(),
      {
        name: 'start-backend',
        configureServer(server) {
          console.log('Starting backend server...');

          // Cleanup port 3001 if in use
          function killPort(port: number) {
            try {
              if (process.platform === 'win32') {
                const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
                const lines = out.split('\n');
                const seen = new Set<string>();
                for (const line of lines) {
                  const parts = line.trim().split(/\s+/);
                  const pid = parts[parts.length - 1];
                  if (pid && !seen.has(pid)) {
                    seen.add(pid);
                    try { execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' }); } catch {}
                  }
                }
              } else {
                execSync(`kill $(lsof -t -i :${port}) 2>/dev/null || true`, { stdio: 'ignore' });
              }
            } catch {}
          }

          killPort(3001);

          const child = spawn(
            'node',
            ['--import', 'tsx/esm', 'server.ts'],
            {
              cwd: process.cwd(),
              stdio: 'inherit',
              shell: false,
              // Force the backend's own port regardless of an inherited PORT env var (e.g. from
              // a dev-server launcher that sets PORT to match Vite's own port) — otherwise the
              // backend binds the same port as Vite itself and crashes with EADDRINUSE.
              env: { ...process.env, PORT: '3001' },
            }
          );

          child.on('error', (err) => {
            console.error('Failed to start backend server:', err);
          });

          server.httpServer?.on('close', () => {
            console.log('Stopping backend server...');
            child.kill();
          });

          process.on('exit', () => {
            child.kill();
          });

          process.on('SIGINT', () => {
            child.kill();
            process.exit();
          });

          process.on('SIGTERM', () => {
            child.kill();
            process.exit();
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3001',
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
