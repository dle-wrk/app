import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';

const server = spawn('node', ['--import', 'tsx/esm', 'server.ts'], {
  cwd: process.cwd(),
  stdio: 'inherit',
  shell: true,
  detached: true,
});

server.unref();
console.log(`Launched API server (pid ${server.pid})`);
