import type { Outcome, StoredState } from './extensionState';

export const prodOrigin = 'https://citizenhangar.space';
const devOrigin = 'http://localhost:3000';
const isDev = process.env.CH_BUILD_PROFILE === 'development';
export const credentialPath = '/api/extension/v2/credential';
export const pairPath = '/api/extension/pair';

export type ApiReply = {
  ok?: boolean;
  outcome?: Outcome;
  error?: string;
  reference?: string;
  next?: number;
  total?: number;
  eat?: string;
  expiresAt?: string;
  accountName?: string;
  accountId?: string;
  deviceId?: string;
};

/** Only an approved origin can receive pairing codes and browser credentials. */
export function dashboardOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.origin === prodOrigin) return prodOrigin;
    if (isDev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      return url.origin;
  } catch {
    // A malformed endpoint is rejected before any credential is sent.
  }
  return undefined;
}

export const defaultOrigin = (devMode?: boolean) => (isDev && devMode ? devOrigin : prodOrigin);
export const connectionOrigin = (state: StoredState) =>
  dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode);

/** Send a bounded request on the pinned origin, without browser cookies or redirects. */
export async function apiRequest(
  origin: string,
  path: string,
  method: string,
  body?: Record<string, unknown>,
  token?: string,
  signal?: AbortSignal,
): Promise<ApiReply> {
  try {
    const response = await fetch(origin + path, {
      method,
      credentials: 'omit',
      cache: 'no-store',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
        : AbortSignal.timeout(20000),
    });
    if (response.status === 204) return { ok: true };
    if (response.status === 429 || response.status >= 500)
      return { ok: false, error: 'network_error' };
    if (response.status === 401 && token) return { ok: false, error: 'invalid_eat' };
    if (response.status === 404) return { ok: false, error: 'unsupported_format' };
    const result: unknown = await response.json();
    if (!result || typeof result !== 'object' || Array.isArray(result))
      return { ok: false, error: 'invalid_response' };
    const reply = result as ApiReply;
    return response.ok ? { ok: true, ...reply } : { ...reply, ok: false };
  } catch {
    return { ok: false, error: 'network_error' };
  }
}
