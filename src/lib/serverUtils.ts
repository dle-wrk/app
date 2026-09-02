// Pure helpers extracted from server.ts so they can be unit-tested without
// booting Express or a database. Each function here is deterministic given
// its inputs (or its explicitly-passed state) — no module-level side effects,
// no env reads except the intentional key-derivation helper.

import { z } from 'zod';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// ---------------------------------------------------------------------------
// AES-256-GCM envelope for pricing provider credentials.
// The 32-byte key is derived from arbitrary material via scrypt so callers
// can pass a passphrase; deriveCredKey is exposed so tests can inject a
// deterministic key instead of relying on process.env.
// ---------------------------------------------------------------------------
export interface CipherEnvelope { v: 1; iv: string; tag: string; ct: string; }

export function isCipherEnvelope(v: any): v is CipherEnvelope {
  return v && typeof v === 'object' && v.v === 1
    && typeof v.iv === 'string' && typeof v.tag === 'string' && typeof v.ct === 'string';
}

export function deriveCredKey(material: string): Buffer {
  return scryptSync(material, 'tracklab-pricing-creds', 32);
}

export function encryptCreds(creds: Record<string, string>, key: Buffer): CipherEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(creds), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { v: 1, iv: iv.toString('base64'), tag: tag.toString('base64'), ct: ct.toString('base64') };
}

export function decryptCreds(env: CipherEnvelope, key: Buffer): Record<string, string> {
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  return JSON.parse(pt);
}

// ---------------------------------------------------------------------------
// Sliding-window rate limiter. The bucket Map is passed in so callers own the
// lifetime — tests get a fresh Map per case, prod uses a module-level one.
// ---------------------------------------------------------------------------
export interface RateLimitResult { allowed: boolean; retryAfter: number; }

export function checkRateLimit(
  buckets: Map<string, number[]>,
  key: string,
  max: number,
  windowMs: number,
  now: number = Date.now(),
): RateLimitResult {
  const cutoff = now - windowMs;
  const hits = (buckets.get(key) || []).filter(t => t > cutoff);
  if (hits.length >= max) {
    return { allowed: false, retryAfter: Math.ceil((hits[0] + windowMs - now) / 1000) };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { allowed: true, retryAfter: 0 };
}

// ---------------------------------------------------------------------------
// Best-effort client-IP extraction. Trusts the first entry in
// X-Forwarded-For — behind Fly's proxy this is the real client.
// ---------------------------------------------------------------------------
export function clientIp(req: any): string {
  return String(
    req?.headers?.['x-forwarded-for']
    ?? req?.headers?.['x-real-ip']
    ?? req?.socket?.remoteAddress
    ?? 'unknown'
  ).split(',')[0].trim().slice(0, 100);
}

// ---------------------------------------------------------------------------
// "data:<mime>;base64,<body>" URL parser for uploaded file attachments.
// ---------------------------------------------------------------------------
export function parseDataUrl(dataUrl: string): { mime: string; body: string } | null {
  const m = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!m) return null;
  return { mime: m[1], body: m[2] };
}

// ---------------------------------------------------------------------------
// app_docs row → DocLink DTO. Kept in sync with DocumentationView's expected
// shape; if you add a column to app_docs, add it here too.
// ---------------------------------------------------------------------------
export interface DocLinkRow {
  id: number;
  title: string;
  description?: string | null;
  url?: string | null;
  file_name?: string | null;
  file_mime?: string | null;
  file_data?: unknown;
  sort_order?: number | null;
  updated_at?: string | Date | null;
  updated_by?: string | null;
}

export const mapDocLink = (r: DocLinkRow) => ({
  id: r.id,
  title: r.title,
  description: r.description || '',
  url: r.file_data ? `/api/docs/${r.id}/file` : (r.url || ''),
  externalUrl: r.file_data ? null : (r.url || null),
  fileName: r.file_name || null,
  fileMime: r.file_mime || null,
  hasAttachment: !!r.file_data,
  sortOrder: r.sort_order,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

// ---------------------------------------------------------------------------
// Zod schemas for request bodies. Kept here so tests can hit them without
// spinning up the whole Express app.
// ---------------------------------------------------------------------------
export const EmailSchema = z.string().email().max(200)
  .transform(v => v.toLowerCase().trim());

export const CreateUserSchema = z.object({
  email: EmailSchema,
  password: z.string().min(8).max(200),
  firstName: z.string().min(1).max(80).optional().nullable(),
  lastName: z.string().min(1).max(80).optional().nullable(),
  role: z.enum(['admin', 'manager', 'engineer', 'viewer']).optional().default('viewer'),
});

export const UpdateUserSchema = z.object({
  firstName: z.string().min(1).max(80).optional().nullable(),
  lastName: z.string().min(1).max(80).optional().nullable(),
  role: z.enum(['admin', 'manager', 'engineer', 'viewer']).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'SUSPENDED']).optional(),
});

export const LoginSchema = z.object({
  email: EmailSchema,
  password: z.string().min(1).max(200),
});

export const SessionIdSchema = z.object({
  sessionId: z.string().min(1).max(200).optional(),
}).partial();

export const DocFileSchema = z.object({
  name: z.string().min(1).max(200),
  mime: z.string().min(1).max(100),
  data: z.string().min(1).max(15_000_000),
}).nullable().optional();

export const DocLinkSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(500).optional().default(''),
  url: z.string().max(2000).optional().default(''),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  file: DocFileSchema,
  removeFile: z.boolean().optional().default(false),
}).refine(v => (v.url && v.url.length > 0) || v.file || v.removeFile === false,
  { message: 'Either a URL or an uploaded file is required.' });
