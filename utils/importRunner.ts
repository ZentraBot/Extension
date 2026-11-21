import { apiRequest, connectionOrigin, credentialPath, type ApiReply } from './extensionApi';
import {
  createAccountSalt,
  logStatus,
  readState,
  type SyncJob,
  type SyncResult,
} from './extensionState';
import { fetchRsiPage, type RsiAccount } from './rsiHangar';

export const autoAlarm = 'hourlySync';
export const resumeAlarm = 'resumeHangarImport';
const maxPages = 250;
const jobLifetime = 60 * 60 * 1000;
const importPath = (reference: string) => `/api/extension/v2/imports/${reference}`;
const candidateErrors = ['rsi_account_unverified', 'rsi_sign_in_required', 'rsi_page_unverified'];

export async function accountSalt() {
  const saved = (await readState()).rsiSalt;
  if (saved) return saved;
  const salt = createAccountSalt();
  await browser.storage.local.set({ rsiSalt: salt });
  return salt;
}

async function setCandidate(account: RsiAccount) {
  const existing = (await readState()).pendingRsiAccount;
  if (existing?.accountKey === account.accountKey) return;
  await browser.storage.local.set({ pendingRsiAccount: { ...account, id: crypto.randomUUID() } });
}

/** Retain the periodic recovery alarm even if a restarted worker cannot retry yet. */
async function ensureResumeAlarm() {
  if (!(await browser.alarms.get(resumeAlarm))) {
    await browser.alarms.create(resumeAlarm, { periodInMinutes: 1 });
  }
}

export async function scheduleHourly(enabled: boolean) {
  if (!enabled) await browser.alarms.clear(autoAlarm);
  else if (!(await browser.alarms.get(autoAlarm)))
    await browser.alarms.create(autoAlarm, { periodInMinutes: 60 });
}

/** Serialize import and credential changes. Cancellation never aborts a publish in progress. */
export function createImportRunner() {
  let running: Promise<SyncResult | undefined> | undefined;
  let controller: AbortController | undefined;
  let committing = false;
  let changingConnection = false;

  async function runImport(
    startNew: boolean,
    signal: AbortSignal,
  ): Promise<SyncResult | undefined> {
    const state = await readState();
    if (!state.eat || (!state.job && !startNew)) return undefined;
    let token = state.eat;
    const origin = connectionOrigin(state);
    const job: SyncJob = state.job || {
      reference: crypto.randomUUID(),
      next: 1,
      total: 1,
      retries: 0,
      started: Date.now(),
      format: 2,
    };
    const save = () => browser.storage.local.set({ job });
    const api = (suffix: string, method: string, body?: Record<string, unknown>) =>
      apiRequest(origin, importPath(job.reference) + suffix, method, body, token, signal);
    await save();
    await ensureResumeAlarm();
    if (job.retryAt && job.retryAt > Date.now()) return undefined;

    /** Clear a completed or abandoned checkpoint only while its credential still owns it. */
    async function finish(reply: ApiReply): Promise<SyncResult> {
      const result: SyncResult = {
        ok: reply.ok === true,
        outcome: reply.outcome || (reply.ok ? 'success' : 'failed'),
        error: reply.error,
        reference: job.reference,
      };
      if (!signal.aborted && (await readState()).eat === token) {
        await browser.storage.local.remove([
          'job',
          ...(reply.error === 'invalid_eat'
            ? [
                'eat',
                'expiresAt',
                'pendingCredential',
                'connectionBase',
                'lastSync',
                'pairedAccountName',
                'rsiSalt',
                'rsiAccount',
                'pendingRsiAccount',
              ]
            : []),
        ]);
        await browser.storage.local.set({
          lastResult: result,
          ...(result.ok ? { lastSync: Date.now() } : {}),
        });
        await browser.alarms.clear(resumeAlarm);
        if (reply.error === 'invalid_eat') await scheduleHourly(false);
        await logStatus(result.ok ? 'info' : 'warn', `Sync ${result.outcome}`);
      }
      return result;
    }

    async function retry(error: string, collection = false): Promise<SyncResult | undefined> {
      if (signal.aborted) return undefined;
      if (job.retries < 3) {
        job.retries += 1;
        job.retryAt = Date.now() + 60000 * 2 ** (job.retries - 1);
        await save();
        return undefined;
      }
      if (collection && job.accountKey) {
        job.issue = job.next > 1 ? 'incomplete_pages' : error;
        return complete();
      }
      return finish({ error });
    }

    async function complete(): Promise<SyncResult | undefined> {
      if (signal.aborted) return undefined;
      // Set the in-memory barrier before awaiting storage. Pairing and cancellation see the same phase.
      committing = true;
      job.phase = 'committing';
      await save();
      const reply = await api('/complete', 'POST', {
        pageCount: job.next - 1,
        issue: job.issue,
        extensionVersion: browser.runtime.getManifest().version,
      });
      if (reply.error === 'network_error') return retry('network_error');
      return finish(reply);
    }

    async function discardPending(error?: string): Promise<SyncResult | undefined> {
      const removed = await api('', 'DELETE');
      if (removed.error === 'network_error') return retry(error || 'cancel_failed');
      if (removed.error === 'import_closed' && job.format === 2) {
        // The server may already have sealed the import before a worker restart.
        job.phase = 'committing';
        delete job.retryAt;
        return complete();
      }
      if (error) return finish({ error });
      if (!signal.aborted) {
        await browser.storage.local.remove('job');
        await browser.alarms.clear(resumeAlarm);
      }
      return undefined;
    }

    if (Date.now() - job.started >= jobLifetime) return finish({ error: 'import_expired' });
    if (job.format !== 2 || job.phase === 'cancelling') return discardPending(job.issue);
    if (
      job.accountKey &&
      job.accountKey !== state.rsiAccount?.accountKey &&
      job.phase !== 'committing'
    ) {
      job.phase = 'cancelling';
      job.issue = 'account_changed';
      await save();
      return discardPending(job.issue);
    }

    if (
      state.pendingCredential ||
      (state.expiresAt && Date.parse(state.expiresAt) - Date.now() < 30 * 86400000)
    ) {
      const replacement = state.pendingCredential || createAccountSalt();
      await browser.storage.local.set({ pendingCredential: replacement });
      const rotated = await apiRequest(
        origin,
        credentialPath,
        'PUT',
        { replacement },
        token,
        signal,
      );
      if (rotated.error === 'network_error') return retry('network_error');
      if (!rotated.ok) return finish(rotated);
      if (signal.aborted || (await readState()).eat !== token) return undefined;
      token = replacement;
      await browser.storage.local.set({
        eat: token,
        expiresAt: rotated.expiresAt,
        pendingCredential: null,
      });
    }

    const salt = await accountSalt();
    let first: Awaited<ReturnType<typeof fetchRsiPage>> | undefined;
    if (!job.accountKey) {
      try {
        first = await fetchRsiPage(1, salt, signal);
      } catch (err) {
        const issue = err instanceof Error ? err.message : '';
        return candidateErrors.includes(issue)
          ? finish({ error: issue })
          : retry('rsi_fetch_failed');
      }
      if (signal.aborted) return undefined;
      if (state.rsiAccount?.accountKey !== first.account.accountKey) {
        await setCandidate(first.account);
        return finish({ error: 'rsi_account_confirmation_required' });
      }
      job.accountKey = first.account.accountKey;
      await save();
    }

    const opened = await api('', 'PUT', { format: 2 });
    if (signal.aborted) return undefined;
    if (opened.outcome || opened.reference) return finish(opened);
    if (opened.error === 'network_error') return retry('network_error');
    if (!opened.ok) return finish(opened);
    if (
      !Number.isInteger(opened.next) ||
      !Number.isInteger(opened.total) ||
      opened.next! < 1 ||
      opened.next! > maxPages + 1 ||
      opened.total! < 1 ||
      opened.next! > opened.total! + 1
    ) {
      return finish({ error: 'invalid_response' });
    }
    if (opened.expiresAt) await browser.storage.local.set({ expiresAt: opened.expiresAt });
    if (opened.next! > job.next) job.retries = 0;
    job.next = opened.next!;
    job.total = Math.max(job.total, opened.total!);
    delete job.retryAt;
    await save();
    if (job.phase === 'committing' || job.issue) return complete();

    while (job.next <= Math.min(job.total, maxPages) && !signal.aborted) {
      let page;
      try {
        page = job.next === 1 && first ? first : await fetchRsiPage(job.next, salt, signal);
      } catch (err) {
        if (signal.aborted) return undefined;
        const issue = err instanceof Error ? err.message : '';
        if (candidateErrors.includes(issue)) {
          if (issue === 'rsi_account_unverified' || issue === 'rsi_page_unverified') {
            job.issue = job.next > 1 ? 'incomplete_pages' : 'rsi_fetch_failed';
          } else job.issue = issue;
          return complete();
        }
        return retry('rsi_fetch_failed', true);
      }
      if (signal.aborted) return undefined;
      if (page.account.accountKey !== job.accountKey) {
        await setCandidate(page.account);
        job.issue = 'account_changed';
        return complete();
      }
      const total = Math.max(job.total, page.total);
      const uploaded = await api(`/pages/${job.next}`, 'PUT', {
        total,
        source: { accountKey: job.accountKey, page: job.next },
        empty: page.empty,
        pledges: page.pledges,
      });
      if (signal.aborted) return undefined;
      if (uploaded.error === 'network_error') return retry('network_error');
      if (uploaded.error === 'invalid_eat') return finish(uploaded);
      if (!uploaded.ok) {
        job.phase = 'cancelling';
        job.issue = uploaded.error || 'invalid_response';
        await save();
        return discardPending(job.issue);
      }
      job.total = total;
      job.next += 1;
      job.retries = 0;
      await save();
    }
    if (job.total > maxPages) job.issue = 'incomplete_pages';
    return complete();
  }

  function sync(startNew = false) {
    if (!running && !changingConnection) {
      controller = new AbortController();
      running = runImport(startNew, controller.signal).finally(() => {
        running = undefined;
        controller = undefined;
        committing = false;
      });
    }
    return running;
  }

  async function cancel() {
    const previous = await readState();
    if (committing || previous.job?.phase === 'committing')
      return { ok: false, error: 'import_busy' };
    controller?.abort();
    await running?.catch(() => {});
    const state = await readState();
    if (state.job?.phase === 'committing') return { ok: false, error: 'import_busy' };
    if (state.job && state.eat) {
      const reply = await apiRequest(
        connectionOrigin(state),
        importPath(state.job.reference),
        'DELETE',
        undefined,
        state.eat,
      );
      if (reply.error === 'network_error') {
        await browser.storage.local.set({
          job: { ...state.job, phase: 'cancelling', retryAt: Date.now() + 60000 },
        });
        await ensureResumeAlarm();
        return { ok: false, error: 'cancel_pending' };
      }
      if (reply.error === 'import_closed') {
        const sealed: SyncJob = { ...state.job, phase: 'committing' };
        delete sealed.retryAt;
        await browser.storage.local.set({ job: sealed });
        await ensureResumeAlarm();
        return { ok: false, error: 'import_busy' };
      }
      if (
        !reply.ok &&
        !['import_expired', 'invalid_eat', 'unsupported_format'].includes(reply.error || '')
      )
        return reply;
    }
    await browser.storage.local.remove('job');
    await browser.alarms.clear(resumeAlarm);
    return { ok: true };
  }

  /** Block new syncs while checking the checkpoint and applying a pairing or disconnect. */
  async function changeConnection(change: () => Promise<ApiReply>): Promise<ApiReply> {
    if (changingConnection) return { ok: false, error: 'import_busy' };
    changingConnection = true;
    try {
      const cancelled = await cancel();
      return cancelled.ok ? await change() : cancelled;
    } finally {
      changingConnection = false;
    }
  }

  return {
    sync,
    changeConnection,
    busy: () => Boolean(running || changingConnection),
    committing: () => committing,
  };
}
