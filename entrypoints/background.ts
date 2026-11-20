const PROD_BASE = 'https://citizenhangar.space';
const DEV_BASE = 'http://localhost:3000';
const RSI_BASE = 'https://robertsspaceindustries.com';

type Outcome = 'success' | 'partial' | 'failed';
type SyncResult = { ok: boolean; outcome: Outcome; error?: string };
type Diagnostic = { ts: string; level: string; msg: string };
type StoredState = {
  eat?: string; connectionBase?: string; lastSync?: number; lastResult?: SyncResult;
  devMode?: boolean; debugEnabled?: boolean; diagnostics?: Diagnostic[];
};

function dashboardOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    if (url.origin === PROD_BASE) return PROD_BASE;
    if (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)) return url.origin;
  } catch { /* An invalid URL cannot receive extension credentials. */ }
  return undefined;
}

const defaultOrigin = (devMode?: boolean) => devMode ? DEV_BASE : PROD_BASE;

export default defineBackground(() => {
  const read = () => browser.storage.local.get([
    'eat', 'connectionBase', 'lastSync', 'lastResult', 'devMode', 'debugEnabled', 'diagnostics',
  ]) as Promise<StoredState>;
  // Old diagnostics included request bodies and pairing credentials.
  const ready = browser.storage.local.remove('__sctr_logs');
  let running: Promise<SyncResult> | undefined;

  async function log(level: string, msg: string) {
    const state = await read();
    if (!state.debugEnabled) return;
    const entry = { ts: new Date().toISOString(), level, msg };
    await browser.storage.local.set({ diagnostics: [entry, ...(state.diagnostics || [])].slice(0, 100) });
  }

  async function post(origin: string, path: string, body: Record<string, unknown>) {
    try {
      const response = await fetch(origin + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      return await response.json();
    } catch {
      return { ok: false, error: 'network_error' };
    }
  }

  async function fetchPledgePage(page: number) {
    const response = await fetch(`${RSI_BASE}/account/pledges?page=${page}`, {
      credentials: 'include', signal: AbortSignal.timeout(15000),
    });
    if (response.status === 401 || response.status === 403 ||
      (response.redirected && !/\/account\/pledges\/?$/.test(new URL(response.url).pathname))) {
      throw new Error('rsi_sign_in_required');
    }
    if (!response.ok) throw new Error('rsi_fetch_failed');
    return response.text();
  }

  function lastPageIn(html: string) {
    let last = 1;
    for (const match of html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)) {
      try {
        const url = new URL(match[1].replace(/&amp;/g, '&'), RSI_BASE);
        const page = Number(url.searchParams.get('page'));
        if (url.origin === RSI_BASE && /\/account\/pledges\/?$/.test(url.pathname)
          && !url.searchParams.has('product-type') && Number.isSafeInteger(page)) last = Math.max(last, page);
      } catch { /* Ignore malformed links. */ }
    }
    return last;
  }

  async function collectPledgePages() {
    const pages: string[] = [];
    let last = 1;
    try {
      for (let page = 1; page <= Math.min(last, 250); page += 1) {
        const html = await fetchPledgePage(page);
        pages.push(html);
        last = Math.max(last, lastPageIn(html));
      }
      return { pages, issue: last > 250 ? 'incomplete_pages' : undefined };
    } catch (err) {
      const signIn = err instanceof Error && err.message === 'rsi_sign_in_required';
      return { pages, issue: pages.length ? 'incomplete_pages' : signIn ? 'rsi_sign_in_required' : 'rsi_fetch_failed' };
    }
  }

  async function performSync(): Promise<SyncResult> {
    const state = await read();
    const eat = state.eat;
    if (!eat) return { ok: false, outcome: 'failed', error: 'not_paired' };
    const origin = dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode);
    const { pages, issue } = await collectPledgePages();
    const result = await post(origin, '/api/extension/pledges', { eat, rawHtmlPages: pages, collectionIssue: issue });
    const ok = result?.ok === true && !issue;
    const outcome: Outcome = ok ? 'success' : result?.outcome === 'partial' || issue === 'incomplete_pages' ? 'partial' : 'failed';
    const error = ok ? undefined : result?.error === 'invalid_eat' ? 'invalid_eat' : issue || result?.error || 'pledge_sync_failed';
    const report = { ok, outcome, ...(error ? { error } : {}) };
    if ((await read()).eat === eat) {
      if (error === 'invalid_eat') await browser.storage.local.remove(['eat', 'connectionBase', 'lastSync']);
      await browser.storage.local.set({ lastResult: report, ...(ok ? { lastSync: Date.now() } : {}) });
    }
    await log(ok ? 'info' : 'warn', `Sync ${outcome}`);
    return report;
  }

  function sync() {
    if (!running) running = performSync().finally(() => { running = undefined; });
    return running;
  }

  browser.alarms.create('hourlySync', { periodInMinutes: 60 });
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === 'hourlySync') {
      await ready;
      await sync().catch(() => log('error', 'Scheduled sync could not finish.'));
    }
  });

  browser.runtime.onMessage.addListener((message, _sender, reply) => {
    async function handle() {
      await ready;
      const action = message?.action || message?.type;
      const state = await read();
      if (action === 'getStatus' || action === 'get-status') {
        return {
          paired: Boolean(state.eat), syncing: Boolean(running), lastSync: state.lastSync,
          lastResult: state.lastResult, devMode: Boolean(state.devMode), debugEnabled: Boolean(state.debugEnabled),
          dashboardUrl: defaultOrigin(state.devMode),
          connectionBase: dashboardOrigin(state.connectionBase) || defaultOrigin(state.devMode),
          diagnostics: state.diagnostics || [],
        };
      }
      if (action === 'exchangeCode' || action === 'pair') {
        const code = message.code || message.payload?.code;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return { ok: false, error: 'invalid_code' };
        const origin = message.baseUrl === undefined ? defaultOrigin(state.devMode) : dashboardOrigin(message.baseUrl);
        if (!origin) return { ok: false, error: 'invalid_dashboard' };
        const result = await post(origin, '/api/extension/pair', { code });
        if (!result?.eat) return { ok: false, error: result?.error || 'pair_failed' };
        if (running) await running.catch(() => {});
        await browser.storage.local.remove(['lastSync', 'lastResult']);
        await browser.storage.local.set({ eat: result.eat, connectionBase: origin, devMode: origin !== PROD_BASE });
        await log('info', 'Browser paired.');
        return { ok: true };
      }
      if (action === 'triggerSync' || action === 'manual-sync' || action === 'initial-sync') return sync();
      if (action === 'set-settings') {
        const settings: Partial<StoredState> = {};
        if (typeof message.devMode === 'boolean') {
          settings.devMode = message.devMode;
          if (state.eat && !state.connectionBase) settings.connectionBase = defaultOrigin(state.devMode);
        }
        if (typeof message.debugEnabled === 'boolean') settings.debugEnabled = message.debugEnabled;
        await browser.storage.local.set(settings);
        return { ok: true };
      }
      if (action === 'clear-logs') {
        await browser.storage.local.remove('diagnostics');
        return { ok: true };
      }
      if (action === 'revoke') {
        await browser.storage.local.remove(['eat', 'connectionBase', 'lastSync', 'lastResult']);
        await log('info', 'Browser disconnected.');
        return { ok: true };
      }
      return { ok: false, error: 'unknown_action' };
    }
    void handle().then(reply, () => reply({ ok: false, error: 'internal_error' }));
    return true;
  });
});
