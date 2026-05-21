/**
 * Tiny API client.
 *
 *   - In-memory access token (refresh cookie is HttpOnly and set by backend).
 *   - On 401, attempts a /auth/refresh once, then retries the original request.
 *   - All requests go through Next.js's /api/* rewrite to the backend.
 */
import type { LoginResponse } from './types';

const BASE = '/api';

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return false;
      const data = (await res.json()) as LoginResponse;
      accessToken = data.accessToken;
      return true;
    } catch {
      return false;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: unknown;
  constructor(status: number, message: string, code?: string, details?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export interface ApiOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
}

async function request<T>(path: string, options: ApiOptions = {}, retried = false): Promise<T> {
  const { body, headers, ...rest } = options;
  const init: RequestInit = {
    ...rest,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(headers as Record<string, string> | undefined),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  };

  const res = await fetch(`${BASE}${path}`, init);

  if (res.status === 401 && !retried && path !== '/auth/refresh' && path !== '/auth/login') {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, options, true);
  }

  if (!res.ok) {
    let errBody: { error?: { code?: string; message?: string; details?: unknown } } | undefined;
    try {
      errBody = (await res.json()) as typeof errBody;
    } catch {
      // ignore
    }
    throw new ApiError(
      res.status,
      errBody?.error?.message ?? res.statusText,
      errBody?.error?.code,
      errBody?.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, options: ApiOptions = {}) => request<T>(path, { method: 'GET', ...options }),
  post: <T>(path: string, body?: unknown, options: ApiOptions = {}) =>
    request<T>(path, { method: 'POST', body, ...options }),
  patch: <T>(path: string, body?: unknown, options: ApiOptions = {}) =>
    request<T>(path, { method: 'PATCH', body, ...options }),
  del: <T>(path: string, options: ApiOptions = {}) => request<T>(path, { method: 'DELETE', ...options }),
};

export async function login(email: string, password: string): Promise<LoginResponse> {
  const data = await api.post<LoginResponse>('/auth/login', { email, password });
  accessToken = data.accessToken;
  return data;
}

export async function logout(): Promise<void> {
  try {
    await api.post('/auth/logout');
  } finally {
    accessToken = null;
  }
}

export async function bootstrapSession(): Promise<boolean> {
  // Attempt to use existing refresh cookie to get an access token. Useful on page load.
  return refreshAccessToken();
}
