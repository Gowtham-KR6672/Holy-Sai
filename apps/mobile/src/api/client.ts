/**
 * The mobile HTTP client. It speaks the same REST API as the web app:
 *  - every call sends `X-Client-Type: mobile`;
 *  - the access token is kept in memory only; the refresh token lives in expo-secure-store;
 *  - a 401 triggers ONE refresh (single-flight — concurrent callers share it) and a single retry;
 *  - refresh tokens rotate on every refresh, so the new one is always stored.
 *
 * Every response is { success, data, message, meta? } or { success: false, message, error, details? }.
 */
import { API_URL } from '@/lib/config';
import { tokenStore } from '@/lib/storage';
import type { LoginPayload, Paged, PageMeta, SessionUser } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
  /** Field → message map for form validation errors. */
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    if (Array.isArray(this.details)) {
      for (const d of this.details as { field?: string; message?: string }[]) {
        if (d?.field && d.message && !out[d.field]) out[d.field] = d.message;
      }
    }
    return out;
  }
  get isNetwork() {
    return this.code === 'NETWORK_ERROR' || this.code === 'TIMEOUT';
  }
}

export interface Envelope<T> {
  success: boolean;
  data: T;
  message: string;
  meta?: PageMeta;
}

type Params = Record<string, string | number | boolean | null | undefined>;

let accessToken: string | null = null;
let sessionEndedListener: (() => void) | null = null;
let refreshing: Promise<RefreshOutcome> | null = null;

export type RefreshOutcome =
  | { kind: 'ok'; accessToken: string; user: SessionUser | null }
  | { kind: 'signed-out' }
  | { kind: 'unreachable'; error: ApiError };

export function setAccessToken(token: string | null) {
  accessToken = token;
}

/** Called when a refresh fails for good (token expired, revoked or reused): the app returns to sign-in. */
export function onSessionEnded(fn: (() => void) | null) {
  sessionEndedListener = fn;
}

export function buildQuery(params?: Params) {
  if (!params) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === 'All') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

async function parse(res: Response): Promise<any> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, message: text.slice(0, 200), error: 'INVALID_RESPONSE' };
  }
}

/** fetch with a timeout (AbortSignal.timeout is not available on every React Native runtime). */
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number, outer?: AbortSignal): Promise<Response> {
  const ctrl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, timeoutMs);
  const onOuterAbort = () => ctrl.abort();
  outer?.addEventListener('abort', onOuterAbort);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (err) {
    if (timedOut) throw new ApiError(0, 'TIMEOUT', 'The server took too long to respond. Please try again.');
    if (outer?.aborted) throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the school server. Check your connection and try again.');
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener('abort', onOuterAbort);
  }
}

function baseHeaders(): Record<string, string> {
  const h: Record<string, string> = { 'X-Client-Type': 'mobile', Accept: 'application/json' };
  if (accessToken) h.Authorization = `Bearer ${accessToken}`;
  return h;
}

/**
 * Exchanges the stored refresh token for a new access token (and a new, rotated refresh token).
 * Concurrent callers share one request so a rotated token is never presented twice.
 */
export function refreshSession(): Promise<RefreshOutcome> {
  if (!refreshing) {
    refreshing = (async (): Promise<RefreshOutcome> => {
      const stored = await tokenStore.get();
      if (!stored) return { kind: 'signed-out' };
      try {
        const res = await fetchWithTimeout(
          `${API_URL}/auth/refresh`,
          { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Client-Type': 'mobile' }, body: JSON.stringify({ refreshToken: stored }) },
          20_000,
        );
        const body = await parse(res);
        if (res.ok && body?.success && body.data?.accessToken) {
          accessToken = body.data.accessToken as string;
          if (body.data.refreshToken) await tokenStore.set(body.data.refreshToken as string);
          return { kind: 'ok', accessToken: accessToken!, user: (body.data.user as SessionUser) ?? null };
        }
        if (res.status === 401 || res.status === 403) {
          accessToken = null;
          await tokenStore.clear();
          return { kind: 'signed-out' };
        }
        return { kind: 'unreachable', error: new ApiError(res.status, body?.error ?? `HTTP_${res.status}`, body?.message ?? `Request failed (${res.status})`) };
      } catch (err) {
        return { kind: 'unreachable', error: err instanceof ApiError ? err : new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the school server.') };
      }
    })().finally(() => {
      refreshing = null;
    });
  }
  return refreshing;
}

export interface RequestOptions {
  params?: Params;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

async function request<T>(method: string, path: string, opts: RequestOptions = {}, retried = false): Promise<Envelope<T>> {
  const headers = baseHeaders();
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  const res = await fetchWithTimeout(`${API_URL}${path}${buildQuery(opts.params)}`, { method, headers, body }, opts.timeoutMs ?? 30_000, opts.signal);

  // Same rule as the web client: /auth/* answers (wrong password, …) never trigger a refresh.
  if (res.status === 401 && !retried && !path.startsWith('/auth/')) {
    const outcome = await refreshSession();
    if (outcome.kind === 'ok') return request<T>(method, path, opts, true);
    if (outcome.kind === 'signed-out') {
      accessToken = null;
      sessionEndedListener?.();
    }
  }

  const json = await parse(res);
  if (!res.ok || !json?.success) {
    throw new ApiError(res.status, json?.error ?? `HTTP_${res.status}`, json?.message ?? `Request failed (${res.status})`, json?.details);
  }
  return json as Envelope<T>;
}

export const api = {
  get: async <T>(path: string, params?: Params, signal?: AbortSignal) => (await request<T>('GET', path, { params, signal })).data,
  getPaged: async <T>(path: string, params?: Params, signal?: AbortSignal): Promise<Paged<T>> => {
    const r = await request<T[]>('GET', path, { params, signal });
    const rows = Array.isArray(r.data) ? r.data : [];
    return { rows, meta: r.meta ?? { page: 1, pageSize: rows.length, total: rows.length, totalPages: 1 } };
  },
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, { body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, { body: body ?? {} }),
  delete: <T>(path: string) => request<T>('DELETE', path),
  /** POST that may run for minutes (AI drafting). */
  postLong: <T>(path: string, body?: unknown, timeoutMs = 300_000) => request<T>('POST', path, { body: body ?? {}, timeoutMs }),
};

/** Sign in with email or mobile number. Stores the refresh token and keeps the access token in memory. */
export async function login(identifier: string, password: string): Promise<SessionUser> {
  const r = await request<LoginPayload>('POST', '/auth/login', { body: { identifier, password, clientType: 'mobile' } });
  accessToken = r.data.accessToken;
  if (r.data.refreshToken) await tokenStore.set(r.data.refreshToken);
  return r.data.user;
}

/** Revokes this device's refresh token on the server (best effort) and forgets it locally. */
export async function logout(): Promise<void> {
  const stored = await tokenStore.get();
  try {
    if (stored) await request('POST', '/auth/logout', { body: { refreshToken: stored }, timeoutMs: 8_000 });
  } catch {
    /* signed out locally regardless */
  } finally {
    accessToken = null;
    await tokenStore.clear();
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return 'Something went wrong. Please try again.';
}
