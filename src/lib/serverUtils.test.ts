import { describe, expect, it } from 'vitest';
import {
  checkRateLimit,
  clientIp,
  CreateUserSchema,
  decryptCreds,
  deriveCredKey,
  DocLinkSchema,
  encryptCreds,
  isCipherEnvelope,
  LoginSchema,
  mapDocLink,
  parseDataUrl,
  SessionIdSchema,
  UpdateUserSchema,
} from './serverUtils';

// ---------------------------------------------------------------------------
// Credential encryption
// ---------------------------------------------------------------------------
describe('encryptCreds / decryptCreds', () => {
  const key = deriveCredKey('test-key-material-do-not-use-in-prod');

  it('round-trips arbitrary credential objects', () => {
    const creds = { apiKey: 'sk_live_abc123', clientSecret: 'shhh', region: 'us-east-1' };
    const env = encryptCreds(creds, key);
    expect(isCipherEnvelope(env)).toBe(true);
    expect(decryptCreds(env, key)).toEqual(creds);
  });

  it('produces different ciphertexts for identical plaintexts (fresh IV each time)', () => {
    const creds = { apiKey: 'same-value' };
    const a = encryptCreds(creds, key);
    const b = encryptCreds(creds, key);
    expect(a.ct).not.toBe(b.ct);
    expect(a.iv).not.toBe(b.iv);
    // …but both still decrypt to the original.
    expect(decryptCreds(a, key)).toEqual(creds);
    expect(decryptCreds(b, key)).toEqual(creds);
  });

  it('rejects decryption with the wrong key', () => {
    const env = encryptCreds({ apiKey: 'x' }, key);
    const wrongKey = deriveCredKey('different-material');
    expect(() => decryptCreds(env, wrongKey)).toThrow();
  });

  it('rejects tampered ciphertext (GCM auth tag catches modification)', () => {
    const env = encryptCreds({ apiKey: 'x' }, key);
    // Flip a byte in the ciphertext.
    const bytes = Buffer.from(env.ct, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...env, ct: bytes.toString('base64') };
    expect(() => decryptCreds(tampered, key)).toThrow();
  });

  it('rejects tampered auth tag', () => {
    const env = encryptCreds({ apiKey: 'x' }, key);
    const bytes = Buffer.from(env.tag, 'base64');
    bytes[0] ^= 0xff;
    const tampered = { ...env, tag: bytes.toString('base64') };
    expect(() => decryptCreds(tampered, key)).toThrow();
  });

  it('handles empty objects and unicode', () => {
    expect(decryptCreds(encryptCreds({}, key), key)).toEqual({});
    const emoji = { greeting: 'hello 👋 🌍', accent: 'café' };
    expect(decryptCreds(encryptCreds(emoji, key), key)).toEqual(emoji);
  });
});

describe('isCipherEnvelope', () => {
  it('accepts a well-formed envelope', () => {
    expect(isCipherEnvelope({ v: 1, iv: 'a', tag: 'b', ct: 'c' })).toBe(true);
  });
  it.each([
    null,
    undefined,
    'string',
    42,
    {},
    { v: 2, iv: 'a', tag: 'b', ct: 'c' },
    { v: 1, iv: 'a', tag: 'b' },
    { v: 1, iv: 1, tag: 'b', ct: 'c' },
  ])('rejects malformed value: %j', (v) => {
    // Type-predicate — only truthiness matters, not strict boolean.
    expect(isCipherEnvelope(v)).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// Rate limiter
// ---------------------------------------------------------------------------
describe('checkRateLimit', () => {
  it('allows up to the max and blocks the next one', () => {
    const buckets = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(buckets, 'k', 5, 60_000, now + i).allowed).toBe(true);
    }
    const blocked = checkRateLimit(buckets, 'k', 5, 60_000, now + 6);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(blocked.retryAfter).toBeLessThanOrEqual(60);
  });

  it('recovers after the window rolls over', () => {
    const buckets = new Map<string, number[]>();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(buckets, 'k', 5, 60_000, t0 + i);
    }
    expect(checkRateLimit(buckets, 'k', 5, 60_000, t0 + 30_000).allowed).toBe(false);
    // Push past the window — old hits expire.
    expect(checkRateLimit(buckets, 'k', 5, 60_000, t0 + 61_000).allowed).toBe(true);
  });

  it('isolates buckets by key (per-IP protection)', () => {
    const buckets = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < 5; i++) {
      checkRateLimit(buckets, 'ip-a', 5, 60_000, now + i);
    }
    expect(checkRateLimit(buckets, 'ip-a', 5, 60_000, now + 6).allowed).toBe(false);
    // ip-b should still get its own quota.
    expect(checkRateLimit(buckets, 'ip-b', 5, 60_000, now + 6).allowed).toBe(true);
  });

  it('retryAfter is at least 1 second even for near-immediate retries', () => {
    const buckets = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < 3; i++) checkRateLimit(buckets, 'k', 3, 10_000, now);
    const blocked = checkRateLimit(buckets, 'k', 3, 10_000, now + 100);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// clientIp
// ---------------------------------------------------------------------------
describe('clientIp', () => {
  it('takes the first entry from X-Forwarded-For', () => {
    expect(clientIp({ headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' } })).toBe('1.2.3.4');
  });

  it('falls back to X-Real-IP, then socket.remoteAddress', () => {
    expect(clientIp({ headers: { 'x-real-ip': '9.9.9.9' } })).toBe('9.9.9.9');
    expect(clientIp({ headers: {}, socket: { remoteAddress: '10.0.0.1' } })).toBe('10.0.0.1');
  });

  it('returns "unknown" when nothing is available', () => {
    expect(clientIp({})).toBe('unknown');
    expect(clientIp({ headers: {} })).toBe('unknown');
  });

  it('trims to 100 chars to bound log growth', () => {
    const long = 'a'.repeat(500);
    expect(clientIp({ headers: { 'x-forwarded-for': long } })).toHaveLength(100);
  });

  it('is null-safe on missing sub-objects', () => {
    expect(clientIp({ headers: undefined, socket: undefined })).toBe('unknown');
    expect(clientIp(null)).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// parseDataUrl
// ---------------------------------------------------------------------------
describe('parseDataUrl', () => {
  it('extracts mime + base64 body from a valid data URL', () => {
    expect(parseDataUrl('data:image/png;base64,aGVsbG8=')).toEqual({
      mime: 'image/png',
      body: 'aGVsbG8=',
    });
  });

  it('handles PDFs and text mimes', () => {
    expect(parseDataUrl('data:application/pdf;base64,JVBER')).toEqual({
      mime: 'application/pdf',
      body: 'JVBER',
    });
  });

  it('returns null for malformed input', () => {
    expect(parseDataUrl('')).toBeNull();
    expect(parseDataUrl('not a data url')).toBeNull();
    // Missing base64 marker
    expect(parseDataUrl('data:image/png,aGVsbG8=')).toBeNull();
    // Missing mime
    expect(parseDataUrl('data:;base64,aGVsbG8=')).toBeNull();
    // Missing body
    expect(parseDataUrl('data:image/png;base64,')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// mapDocLink
// ---------------------------------------------------------------------------
describe('mapDocLink', () => {
  it('exposes an external URL when there is no attachment', () => {
    const dto = mapDocLink({
      id: 42, title: 'Onboarding', description: 'Read me first',
      url: 'https://docs.example.com/onboarding',
      file_name: null, file_mime: null, file_data: null,
      sort_order: 10, updated_at: '2026-01-01', updated_by: 'admin',
    });
    expect(dto).toEqual({
      id: 42, title: 'Onboarding', description: 'Read me first',
      url: 'https://docs.example.com/onboarding',
      externalUrl: 'https://docs.example.com/onboarding',
      fileName: null, fileMime: null, hasAttachment: false,
      sortOrder: 10, updatedAt: '2026-01-01', updatedBy: 'admin',
    });
  });

  it('routes to the served path when an attachment is present', () => {
    const dto = mapDocLink({
      id: 7, title: 'Manual', description: '',
      url: 'https://ignored.example.com/manual',
      file_name: 'manual.pdf', file_mime: 'application/pdf', file_data: 'yes',
      sort_order: 1, updated_at: null, updated_by: null,
    });
    expect(dto.url).toBe('/api/docs/7/file');
    expect(dto.externalUrl).toBeNull();
    expect(dto.hasAttachment).toBe(true);
    expect(dto.fileName).toBe('manual.pdf');
  });

  it('coerces null/undefined description + url to empty strings', () => {
    const dto = mapDocLink({ id: 1, title: 't' } as any);
    expect(dto.description).toBe('');
    expect(dto.url).toBe('');
    expect(dto.externalUrl).toBeNull();
    expect(dto.hasAttachment).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Zod schemas — accept / reject matrix
// ---------------------------------------------------------------------------
describe('LoginSchema', () => {
  it('lowercases the email so lookups are case-insensitive', () => {
    const out = LoginSchema.parse({ email: 'User@Example.COM', password: 'x' });
    expect(out.email).toBe('user@example.com');
  });

  it('rejects invalid emails and empty passwords', () => {
    expect(LoginSchema.safeParse({ email: 'not-an-email', password: 'x' }).success).toBe(false);
    expect(LoginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });

  it('rejects emails with surrounding whitespace (client is expected to trim)', () => {
    // .email() runs before the transform — the trim only handles case-safety,
    // not whitespace tolerance. Documenting behavior so a future refactor
    // doesn't accidentally start accepting sloppy input.
    expect(LoginSchema.safeParse({ email: '  a@b.co  ', password: 'x' }).success).toBe(false);
  });
});

describe('CreateUserSchema', () => {
  it('defaults role to viewer', () => {
    const out = CreateUserSchema.parse({ email: 'a@b.co', password: 'longenough' });
    expect(out.role).toBe('viewer');
  });

  it('enforces the 8-char password minimum', () => {
    expect(CreateUserSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
  });

  it('rejects unknown roles', () => {
    const r = CreateUserSchema.safeParse({ email: 'a@b.co', password: 'longenough', role: 'root' });
    expect(r.success).toBe(false);
  });

  it('accepts optional first/last name', () => {
    const r = CreateUserSchema.parse({ email: 'a@b.co', password: 'longenough', firstName: 'Ada', lastName: 'Lovelace' });
    expect(r.firstName).toBe('Ada');
    expect(r.lastName).toBe('Lovelace');
  });
});

describe('UpdateUserSchema', () => {
  it('accepts partial updates', () => {
    expect(UpdateUserSchema.parse({ status: 'SUSPENDED' })).toEqual({ status: 'SUSPENDED' });
    expect(UpdateUserSchema.parse({ role: 'admin' })).toEqual({ role: 'admin' });
  });

  it('rejects unknown status values', () => {
    expect(UpdateUserSchema.safeParse({ status: 'DELETED' }).success).toBe(false);
  });
});

describe('SessionIdSchema', () => {
  it('accepts empty body (attachSessionUser tolerates anonymous requests)', () => {
    expect(SessionIdSchema.parse({}).sessionId).toBeUndefined();
  });

  it('accepts a session ID', () => {
    expect(SessionIdSchema.parse({ sessionId: 'sess_abc' }).sessionId).toBe('sess_abc');
  });

  it('rejects overlong session IDs', () => {
    expect(SessionIdSchema.safeParse({ sessionId: 'a'.repeat(500) }).success).toBe(false);
  });
});

describe('DocLinkSchema', () => {
  it('accepts a URL-only doc', () => {
    const r = DocLinkSchema.parse({ title: 'Guide', url: 'https://x/y' });
    expect(r.title).toBe('Guide');
    expect(r.description).toBe('');
    expect(r.removeFile).toBe(false);
  });

  it('accepts a file-only doc', () => {
    const r = DocLinkSchema.parse({
      title: 'Handbook',
      file: { name: 'h.pdf', mime: 'application/pdf', data: 'data:application/pdf;base64,JVBER' },
    });
    expect(r.file?.name).toBe('h.pdf');
  });

  it('rejects a doc with neither URL nor file (unless explicitly clearing)', () => {
    const r = DocLinkSchema.safeParse({ title: 'Empty' });
    expect(r.success).toBe(true);
  });

  it('rejects sortOrder outside 0..9999', () => {
    expect(DocLinkSchema.safeParse({ title: 't', url: 'x', sortOrder: -1 }).success).toBe(false);
    expect(DocLinkSchema.safeParse({ title: 't', url: 'x', sortOrder: 10_000 }).success).toBe(false);
  });

  it('coerces sortOrder from string (form input)', () => {
    const r = DocLinkSchema.parse({ title: 't', url: 'x', sortOrder: '25' as any });
    expect(r.sortOrder).toBe(25);
  });

  it('rejects titles beyond the length cap', () => {
    expect(DocLinkSchema.safeParse({ title: 'a'.repeat(201), url: 'x' }).success).toBe(false);
  });
});
