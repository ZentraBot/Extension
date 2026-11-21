import './style.css';

type SyncReport = {
  ok: boolean;
  outcome?: 'success' | 'partial' | 'failed';
  error?: string;
  reference?: string;
};
type Status = {
  paired: boolean;
  syncing: boolean;
  lastSync?: number;
  lastResult?: SyncReport;
  autoSync: boolean;
  nextSync?: number;
  progress?: { current: number; total: number; retryAt?: number; committing?: boolean };
  dashboardUrl: string;
  connectionBase: string;
  devMode: boolean;
  debugEnabled: boolean;
  diagnostics: { ts: string; level: string; msg: string }[];
};

const get = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const feedback = get('feedback');
const code = get<HTMLInputElement>('code');
const pairing = get('pairing');
const connected = get('connected');
const sync = get<HTMLButtonElement>('sync');
const form = get<HTMLFormElement>('pair-form');
const pair = form.querySelector('button')!;
const dev = get<HTMLInputElement>('dev');
const debug = get<HTMLInputElement>('debug');
const auto = get<HTMLInputElement>('auto-sync');
const cancelSync = get<HTMLButtonElement>('cancel-sync');
let polling = false;
let busy = false;
const manifest = browser.runtime.getManifest();
const localAllowed = [
  ...(manifest.permissions || []),
  ...(manifest.host_permissions || []),
].includes('http://localhost/*');
if (!localAllowed) dev.closest('label')!.hidden = true;

/** Translate a persisted import result into an actionable status message. */
const describe = (result: SyncReport) => {
  if (result.ok) return 'Import complete.';
  if (result.error === 'import_expired')
    return 'This import expired. Select Sync now to start again.';
  if (result.error === 'superseded') return 'A newer import has already been recorded.';
  if (result.error === 'invalid_page' || result.error === 'import_too_large')
    return 'This hangar exceeds the import size limit.';

  if (result.error === 'rsi_sign_in_required')
    return 'Sign in to RSI in this browser, then try Sync now again.';
  if (result.outcome === 'partial')
    return 'Only part of your hangar could be read. Your previous inventory is still available.';
  if (result.error === 'invalid_eat' || result.error === 'not_paired')
    return 'This browser needs to be paired again.';
  if (result.error === 'network_error')
    return 'Could not reach Citizen Hangar. Try again in a moment.';
  return 'The import could not finish. Check your RSI hangar and try again.';
};

function show(message: string, error = false) {
  if (feedback.textContent !== message) feedback.textContent = message;
  feedback.dataset.error = String(error);
}

/** Render the latest background state without writing browser credentials into the popup. */
async function refresh() {
  const status: Status = await browser.runtime.sendMessage({ type: 'getStatus' });
  if (typeof status?.paired !== 'boolean') throw new Error('Status unavailable');
  pairing.hidden = status.paired;
  connected.hidden = !status.paired;
  get('sync-settings').hidden = !status.paired;
  get('rsi-login').hidden = status.lastResult?.error !== 'rsi_sign_in_required';
  auto.checked = status.autoSync;
  get('next-sync').textContent =
    status.autoSync && status.nextSync ? new Date(status.nextSync).toLocaleString('en-GB') : 'Off';
  cancelSync.hidden = !status.syncing || Boolean(status.progress?.committing);
  get('sync-progress').hidden = !status.progress;
  const progress = get<HTMLProgressElement>('progress');
  if (status.progress) {
    progress.max = status.progress.total;
    progress.value = status.progress.current;
    get('progress-label').textContent = `${status.progress.current} of ${status.progress.total}`;
  }
  if (status.syncing) {
    if (status.progress?.committing && !status.progress?.retryAt) show('Saving your inventory…');
    else if (status.progress?.retryAt)
      show(`Will retry at ${new Date(status.progress.retryAt).toLocaleTimeString('en-GB')}.`);
    else show('Reading RSI pledge pages…');
  }
  pair.disabled = busy;
  sync.disabled = busy || status.syncing;
  get<HTMLAnchorElement>('pair-dashboard').href = status.dashboardUrl + '/?view=extension';
  get<HTMLAnchorElement>('pledges').href = status.connectionBase + '/?view=pledges';
  get('last-sync').textContent = status.lastSync
    ? new Date(status.lastSync).toLocaleString('en-GB')
    : 'Never';
  get('last-result').textContent = status.syncing
    ? 'In progress'
    : status.lastResult?.ok
      ? 'Complete'
      : status.lastResult?.outcome === 'partial'
        ? 'Partial · inventory kept'
        : status.lastResult
          ? 'Failed · inventory kept'
          : 'No attempts yet';
  dev.checked = status.devMode;
  debug.checked = status.debugEnabled;
  const reference = get('support-reference');
  reference.hidden = !status.lastResult?.reference;
  get('support-code').textContent = status.lastResult?.reference || '';
  get('logs').textContent =
    status.diagnostics
      .slice(0, 25)
      .map((entry) => `${entry.ts} [${entry.level}] ${entry.msg}`)
      .join('\n') || 'No diagnostic messages.';
  return status;
}

/** Disable conflicting controls while one popup action is running. */
async function run(action: () => Promise<void>) {
  if (busy) return;
  busy = true;
  pair.disabled = sync.disabled = true;
  try {
    await action();
  } catch {
    show('The extension could not complete that action. Try again.', true);
  } finally {
    busy = false;
    pair.disabled = sync.disabled = false;
    await refresh().catch(() =>
      show('Extension status is unavailable. Reopen the popup to retry.', true),
    );
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void run(async () => {
    show('Pairing this browser…');
    const result: SyncReport = await browser.runtime.sendMessage({
      type: 'exchangeCode',
      code: code.value.trim(),
    });
    if (!result?.ok) {
      const message =
        result?.error === 'network_error'
          ? 'Could not reach Citizen Hangar. Try again.'
          : result?.error === 'extension_disabled'
            ? 'Pairing is temporarily unavailable. Try again later.'
            : result?.error === 'invalid_dashboard'
              ? 'Open the Dashboard to pair this browser.'
              : 'That code is invalid, expired, or already used. Get a fresh code from the Dashboard.';
      show(message, true);
      code.select();
      return;
    }
    form.reset();
    show('Browser paired. Select Sync now to import your pledges.');
  });
});

sync.addEventListener(
  'click',
  () =>
    void run(async () => {
      const reply = await browser.runtime.sendMessage({ type: 'triggerSync' });
      if (!reply?.ok) throw new Error('Could not start import');
      show('Reading RSI pledge pages…');
      const status = await refresh();
      if (status.syncing) watchImport();
      else if (status.lastResult) show(describe(status.lastResult), !status.lastResult.ok);
    }),
);

cancelSync.addEventListener(
  'click',
  () =>
    void run(async () => {
      const reply = await browser.runtime.sendMessage({ type: 'cancel-sync' });
      show(reply?.ok ? 'Import cancelled.' : 'The import is already saving.', !reply?.ok);
    }),
);

for (const [control, setting] of [
  [dev, 'devMode'],
  [debug, 'debugEnabled'],
  [auto, 'autoSync'],
] as const) {
  control.addEventListener(
    'change',
    () =>
      void run(async () => {
        const result = await browser.runtime.sendMessage({
          type: 'set-settings',
          [setting]: control.checked,
        });
        if (!result?.ok) throw new Error('Settings save failed');
        show('Diagnostic settings saved.');
      }),
  );
}

get('clear-logs').addEventListener(
  'click',
  () =>
    void run(async () => {
      const result = await browser.runtime.sendMessage({ type: 'clear-logs' });
      if (!result?.ok) throw new Error('Diagnostics clear failed');
      show('Diagnostics cleared.');
    }),
);

/** Poll only until the job leaves an active state or the popup loses access to the runtime. */
function watchImport() {
  if (polling) return;
  polling = true;
  const poll = async () => {
    try {
      const status = await refresh();
      if (status.syncing) {
        window.setTimeout(poll, 1000);
        return;
      }
      if (status.lastResult && feedback.textContent !== 'Import cancelled.') {
        show(describe(status.lastResult), !status.lastResult.ok);
      }
    } catch {
      show('Extension status is unavailable. Reopen the popup to retry.', true);
    }
    polling = false;
  };
  window.setTimeout(poll, 1000);
}

void refresh()
  .then((status) => {
    if (status.syncing) watchImport();
    else if (status.lastResult && !status.lastResult.ok) show(describe(status.lastResult), true);
    else show('');
  })
  .catch(() => show('Extension status is unavailable. Reopen the popup to retry.', true));
