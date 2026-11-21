import {
  apiRequest,
  connectionOrigin,
  credentialPath,
  pairPath,
  prodOrigin,
  type ApiReply,
} from './extensionApi';
import { logStatus, readState, type PendingPair, type StoredState } from './extensionState';
import { scheduleHourly, type createImportRunner } from './importRunner';

const pairFields = [
  'eat',
  'expiresAt',
  'pendingCredential',
  'connectionBase',
  'pairedAccountName',
  'rsiSalt',
  'rsiAccount',
  'pendingRsiAccount',
  'lastSync',
  'lastResult',
];
const hasExpired = (pending: PendingPair) => Date.parse(pending.expiresAt) <= Date.now();

/** Identity is issued by the selected Dashboard, never by the page bridge. */
export function createConnections(runner: ReturnType<typeof createImportRunner>) {
  let previewVersion = 0;
  let checked: { token: string; at: number } | undefined;

  function visiblePair(state: StoredState) {
    const pair = state.pendingPair;
    if (!pair || hasExpired(pair)) return undefined;
    const { id, accountName, expiresAt } = pair;
    return { id, accountName, expiresAt };
  }

  async function queuePair(origin: string, code: unknown) {
    if (typeof code !== 'string' || !/^\d{6}$/.test(code))
      return { ok: false, error: 'invalid_code' };
    const version = ++previewVersion;
    const preview = await apiRequest(origin, `${pairPath}/preview`, 'POST', { code });
    if (!preview.ok) return { ok: false, error: preview.error || 'pair_failed' };
    const { accountId, accountName, expiresAt } = preview;
    if (!accountId || !accountName || !expiresAt || !(Date.parse(expiresAt) > Date.now())) {
      return { ok: false, error: 'invalid_response' };
    }
    const current = (await readState()).pendingPair;
    if (previewVersion !== version) return { ok: false, error: 'confirmation_expired' };
    if (current?.code !== code || current.origin !== origin || hasExpired(current)) {
      await browser.storage.local.set({
        pendingPair: {
          id: crypto.randomUUID(),
          code,
          origin,
          accountId,
          accountName,
          expiresAt,
        },
      });
    }
    return { ok: true, confirmationRequired: true };
  }

  async function confirmPair(id: unknown) {
    const proposal = (await readState()).pendingPair;
    if (!proposal || proposal.id !== id || hasExpired(proposal))
      return { ok: false, error: 'confirmation_expired' };
    return runner.changeConnection(async () => {
      const state = await readState();
      const pending = state.pendingPair;
      if (!pending || pending.id !== id || hasExpired(pending))
        return { ok: false, error: 'confirmation_expired' };
      // Confirm removal of the old credential before adopting a new identity. If
      // redemption then fails, the still-open proposal can be retried from a disconnected state.
      if (state.eat) {
        const old = await removeCredential(state);
        if (!old.ok && old.error !== 'invalid_eat')
          return { ok: false, error: old.error || 'disconnect_failed' };
        await dropLocalPair(false);
      }
      const label = /Firefox/i.test(navigator.userAgent)
        ? 'Firefox extension'
        : 'Chromium extension';
      const result = await apiRequest(pending.origin, pairPath, 'POST', {
        code: pending.code,
        label,
        expectedAccountId: pending.accountId,
      });
      if (!result.eat || result.accountId !== pending.accountId) {
        return { ok: false, error: result.error || 'pair_failed' };
      }
      await browser.storage.local.remove([
        'lastSync',
        'lastResult',
        'rsiSalt',
        'rsiAccount',
        'pendingRsiAccount',
      ]);
      await browser.storage.local.set({
        eat: result.eat,
        expiresAt: result.expiresAt,
        pendingCredential: null,
        connectionBase: pending.origin,
        devMode: pending.origin !== prodOrigin,
        pairedAccountName: result.accountName || pending.accountName,
      });
      if ((await readState()).pendingPair?.id === pending.id)
        await browser.storage.local.remove('pendingPair');
      await scheduleHourly(state.autoSync === true);
      await logStatus('info', 'Browser paired.');
      return { ok: true };
    });
  }

  async function dismissPair(id: unknown) {
    const pending = (await readState()).pendingPair;
    if (!pending || pending.id !== id) return { ok: false, error: 'confirmation_expired' };
    await browser.storage.local.remove('pendingPair');
    return { ok: true };
  }

  function removeCredential(state: StoredState) {
    return apiRequest(
      connectionOrigin(state),
      credentialPath,
      'DELETE',
      state.pendingCredential ? { replacement: state.pendingCredential } : undefined,
      state.eat,
    );
  }

  async function dropLocalPair(removeProposal = true) {
    await browser.storage.local.remove(
      removeProposal ? [...pairFields, 'pendingPair'] : pairFields,
    );
    await scheduleHourly(false);
    await logStatus('info', 'Browser disconnected.');
    return { ok: true };
  }

  function disconnect() {
    return runner.changeConnection(async () => {
      const state = await readState();
      if (state.eat) {
        const reply = await removeCredential(state);
        if (!reply.ok && reply.error !== 'invalid_eat') return reply;
      }
      return dropLocalPair();
    });
  }

  /** A dashboard tab may ask for a refresh, but only server-confirmed revocation clears the binding. */
  async function refreshPair(origin: string): Promise<ApiReply> {
    const state = await readState();
    if (!state.eat || connectionOrigin(state) !== origin) return { ok: true };
    const reply = await apiRequest(origin, credentialPath, 'GET', undefined, state.eat);
    if (reply.error !== 'invalid_eat') {
      if (reply.ok && (await readState()).eat === state.eat) {
        await browser.storage.local.set({
          ...(reply.accountName ? { pairedAccountName: reply.accountName } : {}),
          ...(reply.expiresAt ? { expiresAt: reply.expiresAt } : {}),
        });
      }
      return { ok: reply.ok === true, error: reply.error };
    }
    if (state.pendingCredential) {
      const replacement = await apiRequest(
        origin,
        credentialPath,
        'GET',
        undefined,
        state.pendingCredential,
      );
      if (replacement.error !== 'invalid_eat')
        return { ok: replacement.ok === true, error: replacement.error };
    }
    return runner.changeConnection(async () =>
      (await readState()).eat === state.eat ? dropLocalPair() : { ok: true },
    );
  }

  /** Polling the popup must not turn one browser's status checks into continuous server traffic. */
  async function validateForStatus(state: StoredState) {
    const token = state.eat;
    if (
      !token ||
      state.job ||
      runner.busy() ||
      (checked?.token === token && Date.now() - checked.at < 30000)
    )
      return state;
    checked = { token, at: Date.now() };
    await refreshPair(connectionOrigin(state));
    return readState();
  }

  return {
    visiblePair,
    queuePair,
    confirmPair,
    dismissPair,
    disconnect,
    refreshPair,
    validateForStatus,
  };
}
