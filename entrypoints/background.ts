const PROD_BASE = 'https://citizenhangar.space';
const DEV_BASE = 'http://localhost:3000';
const RSI_BASE = 'https://robertsspaceindustries.com';
const isDev = process.env.CH_BUILD_PROFILE === 'development';

type Outcome = 'success' | 'partial' | 'failed';
type SyncResult = { ok: boolean; outcome: Outcome; error?: string; reference?: string };
type SyncJob = {
  reference: string;
  next: number;
  total: number;
  retries: number;
  started: number;
  retryAt?: number;
  issue?: string;
  phase?: 'committing';
};
type ImportReply = {
  ok?: boolean;
  outcome?: Outcome;
  error?: string;
  reference?: string;
  next?: number;
  total?: number;
  eat?: string;
  expiresAt?: string;
};
const autoAlarm = 'hourlySync';
const resumeAlarm = 'resumeHangarImport';
const maxPages = 250;
type Diagnostic = { ts: string; level: string; msg: string };
type StoredState = {
  eat?: string;
  expiresAt?: string;
  pendingCredential?: string | null;
  connectionBase?: string;
  lastSync?: number;
  lastResult?: SyncResult;
  job?: SyncJob;
  autoSync?: boolean;
  devMode?: boolean;
  debugEnabled?: boolean;
  diagnostics?: Diagnostic[];
};

/** Only approved origins can receive pairing codes and extension credentials. */
function dashboardOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.origin === PROD_BASE) return PROD_BASE;
    if (isDev && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))
      return url.origin;
  } catch {
    /* An invalid URL cannot receive extension credentials. */
  }
  return undefined;
}

const defaultOrigin = (devMode?: boolean) => (isDev && devMode ? DEV_BASE : PROD_BASE);

export default defineBackground(() => {
  const read = () =>
    browser.storage.local.get([
      'eat',
      'expiresAt',
      'pendingCredential',
      'connectionBase',
      'lastSync',
      'lastResult',
      'job',
      'autoSync',
      'devMode',
      'debugEnabled',
      'diagnostics',
    ]) as Promise<StoredState>;
  // Old diagnostics included request bodies and pairing credentials.
  const ready = browser.storage.local.remove('__sctr_logs');
  let running: Promise<SyncResult | undefined> | undefined;
  let controller: AbortController | undefined;

  async function log(level: string, msg: string) {
    const state = await read();
    if (!state.debugEnabled) return;
    const entry = { ts: new Date().toISOString(), level, msg };
    await browser.storage.local.set({
      diagnostics: [entry, ...(state.diagnostics || [])].slice(0, 100),
    });
  }

  /** Send a bounded API request without browser cookies and classify retryable failures. */
  async function request(
    origin: string,
    path: string,
    method: string,
    body?: Record<string, unknown>,
    token?: string,
    signal?: AbortSignal,
  ): Promise<ImportReply> {
    try {
      const response = await fetch(origin + path, {
        method,
        credentials: 'omit',
        cache: 'no-store',
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
      return await response.json();
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  /** Read RSI with the active browser session and distinguish sign-in failures from transient errors. */
  async function fetchPledgePage(page: number, signal: AbortSignal) {
    const response = await fetch(`${RSI_BASE}/account/pledges?page=${page}`, {
      credentials: 'include',
      signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.redirected && !/\/account\/pledges\/?$/.test(new URL(response.url).pathname))
    ) {
      throw new Error('rsi_sign_in_required');
    }
    if (!response.ok) throw new Error('rsi_fetch_failed');
    return response.text();
  }

  /** Discover the last unfiltered inventory page using only RSI hangar links. */
  function lastPageIn(html: string) {
    let last = 1;
    for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      try {
        const url = new URL(match[1].replace(/&amp;/g, '&'), RSI_BASE);
        const page = Number(url.searchParams.get('page'));
        if (
          url.origin === RSI_BASE &&
          /\/account\/pledges\/?$/.test(url.pathname) &&
          !url.searchParams.has('product-type') &&
          Number.isSafeInteger(page)
        )
          last = Math.max(last, page);
      } catch {
        /* Ignore malformed links. */
      }
    }
    return last;
  }

  /** Collect and checkpoint one import. Browser restarts resume from the server’s acknowledged page. */
  async function runImport(
    startNew: boolean,
    signal: AbortSignal,
  ): Promise<SyncResult | undefined> {
    const state = await read();
    if (!state.eat || (!state.job && !startNew)) return undefined;
    let token = state.eat;
    const job = state.job || {
      reference: crypto.randomUUID(),
      next: 1,
      total: 1,
      retries: 0,
      started: Date.now(),
    };
    if (job.retryAt && job.retryAt > Date.now()) return undefined;
    const save = () => browser.storage.local.set({ job });
    const origin = dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode);
    const path = '/api/extension/v2/imports/' + job.reference;
    const api = (suffix: string, method: string, body?: Record<string, unknown>) =>
      request(origin, path + suffix, method, body, token, signal);
    await save();
    // A periodic alarm can recover a suspended background service worker.
    if (!(await browser.alarms.get(resumeAlarm)))
      await browser.alarms.create(resumeAlarm, { periodInMinutes: 1 });

    /** Record the final outcome only when the active credential still owns the job. */
    async function finish(reply: ImportReply): Promise<SyncResult> {
      const result = {
        ok: reply.ok === true,
        outcome: reply.outcome || (reply.ok ? 'success' : 'failed'),
        error: reply.error,
        reference: job.reference,
      } satisfies SyncResult;
      if (!signal.aborted && (await read()).eat === token) {
        await browser.storage.local.remove([
          'job',
          ...(reply.error === 'invalid_eat'
            ? ['eat', 'expiresAt', 'pendingCredential', 'connectionBase', 'lastSync']
            : []),
        ]);
        await browser.storage.local.set({
          lastResult: result,
          ...(result.ok ? { lastSync: Date.now() } : {}),
        });
        await browser.alarms.clear(resumeAlarm);
        await log(result.ok ? 'info' : 'warn', `Sync ${result.outcome}`);
      }
      return result;
    }

    /** Persist exponential backoff so worker suspension does not reset the retry budget. */
    async function retry(fallback: string, collectError = false): Promise<SyncResult | undefined> {
      if (signal.aborted) return undefined;
      if (job.retries < 3) {
        job.retries += 1;
        job.retryAt = Date.now() + 60000 * 2 ** (job.retries - 1);
        await save();
        return undefined;
      }
      if (collectError) {
        job.issue = job.next > 1 ? 'incomplete_pages' : fallback;
        await save();
        return complete();
      }
      return finish({ error: fallback });
    }

    /** Freeze the collection before asking the server to publish the snapshot. */
    async function complete(): Promise<SyncResult | undefined> {
      if (signal.aborted) return undefined;
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

    if (Date.now() - job.started >= 60 * 60 * 1000) return finish({ error: 'import_expired' });
    if (
      state.pendingCredential ||
      (state.expiresAt && Date.parse(state.expiresAt) - Date.now() < 30 * 86400000)
    ) {
      const pendingCredential =
        state.pendingCredential ||
        [...crypto.getRandomValues(new Uint8Array(32))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('');
      await browser.storage.local.set({ pendingCredential });
      const rotated = await request(
        origin,
        '/api/extension/v2/credential',
        'PUT',
        { replacement: pendingCredential },
        token,
        signal,
      );
      if (rotated.error === 'network_error') return retry('network_error');
      if (!rotated.ok) return finish(rotated);
      if ((await read()).eat !== token) return undefined;
      token = pendingCredential;
      await browser.storage.local.set({
        eat: token,
        expiresAt: rotated.expiresAt,
        pendingCredential: null,
      });
    }
    const opened = await api('', 'PUT', { format: 1 });
    if (signal.aborted) return undefined;
    if (opened.outcome || opened.reference) return finish(opened);
    if (opened.error === 'network_error') return retry('network_error');
    if (!opened.ok) return finish(opened);
    if (opened.expiresAt) await browser.storage.local.set({ expiresAt: opened.expiresAt });
    job.next = opened.next || 1;
    job.total = Math.max(job.total, opened.total || 1);
    delete job.retryAt;
    await save();
    if (job.phase || job.issue) return complete();

    while (job.next <= Math.min(job.total, maxPages) && !signal.aborted) {
      let html: string;
      try {
        html = await fetchPledgePage(job.next, signal);
      } catch (err) {
        if (signal.aborted) return undefined;
        if (err instanceof Error && err.message === 'rsi_sign_in_required') {
          job.issue = 'rsi_sign_in_required';
          return complete();
        }
        return retry('rsi_fetch_failed', true);
      }
      const total = Math.max(job.total, lastPageIn(html));
      const reply = await api('/pages/' + job.next, 'PUT', { html, total });
      if (signal.aborted) return undefined;
      if (reply.error === 'network_error') return retry('network_error');
      if (!reply.ok) return finish(reply);
      job.total = total;
      job.next += 1;
      job.retries = 0;
      await save();
    }
    if (job.total > maxPages) job.issue = 'incomplete_pages';
    return complete();
  }

  /** Serialize imports from manual requests and alarms. */
  function sync(startNew = false) {
    if (!running) {
      controller = new AbortController();
      running = runImport(startNew, controller.signal).finally(() => {
        running = undefined;
        controller = undefined;
      });
    }
    return running;
  }

  async function schedule(enabled: boolean) {
    if (!enabled) await browser.alarms.clear(autoAlarm);
    else if (!(await browser.alarms.get(autoAlarm)))
      await browser.alarms.create(autoAlarm, { periodInMinutes: 60 });
  }

  /** Abort collection and discard its draft while a commit is still avoidable. */
  async function cancel(state: StoredState) {
    if (state.job?.phase === 'committing') return false;
    controller?.abort();
    await running?.catch(() => {});
    const { job, eat } = await read();
    await browser.storage.local.remove('job');
    await browser.alarms.clear(resumeAlarm);
    if (job && eat) {
      const origin = dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode);
      await request(origin, '/api/extension/v2/imports/' + job.reference, 'DELETE', undefined, eat);
    }
    return true;
  }

  void ready
    .then(async () => {
      const state = await read();
      await schedule(state.autoSync !== false);
      if (state.job) void sync().catch(() => log('error', 'Import will resume on the next alarm.'));
    })
    .catch(() => {});
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== autoAlarm && alarm.name !== resumeAlarm) return;
    return ready.then(async () => {
      const state = await read();
      if (alarm.name === resumeAlarm && !state.job) return browser.alarms.clear(resumeAlarm);
      if (alarm.name === resumeAlarm || state.autoSync !== false) {
        await sync(alarm.name === autoAlarm).catch(() =>
          log('error', 'Scheduled sync could not finish.'),
        );
      }
    });
  });

  browser.runtime.onMessage.addListener((message, _sender, reply) => {
    async function handle() {
      await ready;
      const action = message?.action || message?.type;
      const state = await read();
      if (action === 'getStatus' || action === 'get-status') {
        return {
          paired: Boolean(state.eat),
          syncing: Boolean(state.job || running),
          lastSync: state.lastSync,
          progress: state.job && {
            current: state.job.next - 1,
            total: state.job.total,
            retryAt: state.job.retryAt,
            committing: state.job.phase === 'committing',
          },
          autoSync: state.autoSync !== false,
          nextSync: (await browser.alarms.get(autoAlarm))?.scheduledTime,
          lastResult: state.lastResult,
          devMode: Boolean(state.devMode),
          debugEnabled: Boolean(state.debugEnabled),
          dashboardUrl: defaultOrigin(state.devMode),
          connectionBase: dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode),
          diagnostics: state.diagnostics || [],
        };
      }
      if (action === 'exchangeCode' || action === 'pair') {
        const code = message.code || message.payload?.code;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code))
          return { ok: false, error: 'invalid_code' };
        const origin =
          message.baseUrl === undefined
            ? defaultOrigin(state.devMode)
            : dashboardOrigin(message.baseUrl);
        if (!origin) return { ok: false, error: 'invalid_dashboard' };
        if (state.job?.phase === 'committing') return { ok: false, error: 'import_busy' };
        const label = /Firefox/i.test(navigator.userAgent)
          ? 'Firefox extension'
          : 'Chromium extension';
        const result = await request(origin, '/api/extension/pair', 'POST', { code, label });
        if (!result?.eat) return { ok: false, error: result?.error || 'pair_failed' };
        await cancel(state);
        await browser.storage.local.remove(['lastSync', 'lastResult']);
        await browser.storage.local.set({
          eat: result.eat,
          expiresAt: result.expiresAt,
          pendingCredential: null,
          connectionBase: origin,
          devMode: origin !== PROD_BASE,
        });
        await log('info', 'Browser paired.');
        return { ok: true };
      }
      if (action === 'triggerSync' || action === 'manual-sync' || action === 'initial-sync') {
        if (!state.eat) return { ok: false, error: 'not_paired' };
        void sync(true).catch(() => log('error', 'Import could not start.'));
        return { ok: true };
      }
      if (action === 'cancel-sync') return { ok: await cancel(state) };
      if (action === 'set-settings') {
        const settings: Partial<StoredState> = {};
        if (typeof message.devMode === 'boolean') {
          settings.devMode = message.devMode;
          if (state.eat && !state.connectionBase)
            settings.connectionBase = defaultOrigin(state.devMode);
        }
        if (typeof message.debugEnabled === 'boolean') settings.debugEnabled = message.debugEnabled;
        if (typeof message.autoSync === 'boolean') {
          settings.autoSync = message.autoSync;
        }
        await browser.storage.local.set(settings);
        if (typeof settings.autoSync === 'boolean') await schedule(settings.autoSync);
        return { ok: true };
      }
      if (action === 'clear-logs') {
        await browser.storage.local.remove('diagnostics');
        return { ok: true };
      }
      if (action === 'revoke') {
        controller?.abort();
        await running?.catch(() => {});
        await browser.alarms.clear(resumeAlarm);
        await browser.storage.local.remove([
          'eat',
          'expiresAt',
          'pendingCredential',
          'connectionBase',
          'lastSync',
          'lastResult',
          'job',
        ]);
        await log('info', 'Browser disconnected.');
        return { ok: true };
      }
      return { ok: false, error: 'unknown_action' };
    }
    void handle().then(reply, () => reply({ ok: false, error: 'internal_error' }));
    return true;
  });
});
