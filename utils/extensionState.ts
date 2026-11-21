import type { RsiAccount } from './rsiHangar';

export type Outcome = 'success' | 'partial' | 'failed';
export type SyncResult = { ok: boolean; outcome: Outcome; error?: string; reference?: string };
export type SyncJob = {
  reference: string;
  next: number;
  total: number;
  retries: number;
  started: number;
  format?: 2;
  accountKey?: string;
  retryAt?: number;
  issue?: string;
  phase?: 'committing' | 'cancelling';
};
export type PendingPair = {
  id: string;
  code: string;
  origin: string;
  accountId: string;
  accountName: string;
  expiresAt: string;
};
export type PendingRsiAccount = RsiAccount & { id: string };
type Diagnostic = { ts: string; level: string; msg: string };
export type StoredState = {
  eat?: string;
  expiresAt?: string;
  pendingCredential?: string | null;
  connectionBase?: string;
  pairedAccountName?: string;
  pendingPair?: PendingPair;
  rsiSalt?: string;
  rsiAccount?: RsiAccount;
  pendingRsiAccount?: PendingRsiAccount;
  lastSync?: number;
  lastResult?: SyncResult;
  job?: SyncJob;
  autoSync?: boolean;
  devMode?: boolean;
  debugEnabled?: boolean;
  diagnostics?: Diagnostic[];
};

/** Fetch only extension state used by the current worker, including legacy pairing fields. */
export const readState = () =>
  browser.storage.local.get([
    'eat',
    'expiresAt',
    'pendingCredential',
    'connectionBase',
    'pairedAccountName',
    'pendingPair',
    'rsiSalt',
    'rsiAccount',
    'pendingRsiAccount',
    'lastSync',
    'lastResult',
    'job',
    'autoSync',
    'devMode',
    'debugEnabled',
    'diagnostics',
  ]) as Promise<StoredState>;

/** Generate a browser-only pepper for the RSI account fingerprint. */
export function createAccountSalt() {
  return [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/** Persist only statuses and counts, with opt-in collection and a fixed record limit. */
export async function logStatus(level: string, msg: string) {
  const state = await readState();
  if (!state.debugEnabled) return;
  const entry = { ts: new Date().toISOString(), level, msg };
  await browser.storage.local.set({
    diagnostics: [entry, ...(state.diagnostics || [])].slice(0, 100),
  });
}
