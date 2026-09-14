// One-shot admin password reset that mirrors what POST /api/users/:id/reset-password
// does, but usable from the local shell when the affected user can't log in
// and the admin isn't near a browser. Prints the temp password on stdout so it
// can be shared out-of-band with the user.

import { neon } from '@neondatabase/serverless';
import bcrypt from 'bcryptjs';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';

const email = process.argv[2];
if (!email) {
  console.error('Usage: node scripts/admin-reset-password.mjs <email>');
  process.exit(1);
}

const env = fs.readFileSync('.env', 'utf8');
const dbUrl = env.match(/DATABASE_URL="([^"]+)"/)[1];
const sql = neon(dbUrl);

function generateTempPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(12);
  let out = '';
  for (let i = 0; i < 12; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const [user] = await sql`SELECT id, email FROM users WHERE email = ${email.toLowerCase().trim()}`;
if (!user) {
  console.error(`No user with email ${email}`);
  process.exit(2);
}

const temp = generateTempPassword();
const hash = await bcrypt.hash(temp, 10);
await sql`UPDATE users
             SET password = ${hash},
                 must_change_password = TRUE,
                 status = 'ACTIVE',
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = ${user.id}`;
await sql`DELETE FROM user_sessions WHERE user_id = ${user.id}`;

console.log(`Reset ${user.email} (id=${user.id})`);
console.log(`Temp password: ${temp}`);
console.log(`must_change_password = TRUE — user will be forced to set a new one on next login.`);
