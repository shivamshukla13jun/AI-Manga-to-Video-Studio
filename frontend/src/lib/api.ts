import { useAuth } from '@/stores/auth';
import { SecureApiClient } from './SecureApiClient';

/**
 * REST client. Same-origin `/api` (Vite proxies to the backend in dev).
 * - bearer token from the auth store, transparent refresh on 401
 * - credentials (login/register) go through the existing RSA+AES-GCM
 *   payload-encryption protocol when the server has it enabled
 */
export const API_BASE = import.meta.env.VITE_API_BASE || '';

export class ApiError extends Error {
  constructor(message: string, public status: number, public errors?: Record<string, any>) {
    super(message);
  }
}

let refreshing: Promise<string | null> | null = null;

const refreshAccessToken = async (): Promise<string | null> => {
  const { refreshToken, setAccessToken, clear } = useAuth.getState();
  if (!refreshToken) return null;
  const res = await fetch(`${API_BASE}/api/auth/refresh-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    clear();
    return null;
  }
  const json = await res.json();
  setAccessToken(json.data.accessToken);
  return json.data.accessToken;
};

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  raw?: boolean;
}

export async function request<T = any>(path: string, opts: RequestOptions = {}, retried = false): Promise<T> {
  const token = useAuth.getState().accessToken;
  const isForm = opts.body instanceof FormData;
  const isBinary = opts.body instanceof Blob || opts.body instanceof ArrayBuffer;
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    signal: opts.signal,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.body && !isForm && !isBinary ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : isForm || isBinary ? (opts.body as BodyInit) : JSON.stringify(opts.body),
  });

  if (res.status === 401 && !retried && useAuth.getState().refreshToken) {
    refreshing = refreshing || refreshAccessToken().finally(() => (refreshing = null));
    if (await refreshing) return request<T>(path, opts, true);
  }
  if (opts.raw) return res as unknown as T;
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.success === false) {
    throw new ApiError(json?.message || `Request failed (${res.status})`, res.status, json?.errors);
  }
  return (json?.data ?? json) as T;
}

export const api = {
  get: <T = any>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  post: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  put: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body: body ?? {} }),
  patch: <T = any>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T = any>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Encrypted request for sensitive payloads; falls back to plain JSON when encryption is disabled server-side. */
let secure: SecureApiClient | null | undefined;
export const securePost = async <T = any>(path: string, body: Record<string, unknown>): Promise<T> => {
  if (secure === undefined) {
    try {
      const probe = await fetch(`${API_BASE}/encryption/public-key`);
      secure = probe.ok ? await new SecureApiClient(API_BASE || window.location.origin).init() : null;
    } catch {
      secure = null;
    }
  }
  if (!secure) return request<T>(path, { method: 'POST', body });
  const r = await secure.post<any>(path, body);
  if (r.status >= 400 || r.body?.success === false) {
    throw new ApiError(r.body?.message || `Request failed (${r.status})`, r.status, r.body?.errors);
  }
  return (r.body?.data ?? r.body) as T;
};
