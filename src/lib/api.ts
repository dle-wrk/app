// Shared JSON API client. Originally lived inside
// src/components/bookkeeping/shared.tsx alongside the bookkeeping UI
// primitives; hoisted here so any component or lib can use it without
// pulling in the bookkeeping surface.
//
// Contract:
//   - Any non-2xx response throws ApiError with either the server's
//     JSON `error` field or "Request failed (<status>)" as its message.
//   - 204 No Content returns null.
//   - Everything else parses the body as JSON and returns it.
//   - No caching, no retry, no in-flight deduplication. If we ever want
//     those, this is the file to swap for TanStack Query / SWR.
//
// The bookkeeping shared.tsx re-exports these so existing
// `import { apiGet } from './shared'` imports keep working without an
// edit; new callers should import from './lib/api' directly.

export class ApiError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function handleResponse(res: Response) {
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      // Server didn't send JSON. Fall back to the generic message.
    }
    throw new ApiError(message, res.status);
  }
  if (res.status === 204) return null;
  return res.json();
}

export async function apiGet(url: string) {
  const res = await fetch(url);
  return handleResponse(res);
}

export async function apiPost(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(res);
}

export async function apiPut(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(res);
}

export async function apiPatch(url: string, body?: any) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  return handleResponse(res);
}

export async function apiDelete(url: string) {
  const res = await fetch(url, { method: 'DELETE' });
  return handleResponse(res);
}
