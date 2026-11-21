import { connectionOrigin, dashboardOrigin, defaultOrigin } from '../utils/extensionApi';
import { createConnections } from '../utils/extensionConnections';
import { logStatus, readState, type StoredState } from '../utils/extensionState';
import {
  accountSalt,
  autoAlarm,
  createImportRunner,
  resumeAlarm,
  scheduleHourly,
} from '../utils/importRunner';
import { fetchRsiPage } from '../utils/rsiHangar';

export default defineBackground(() => {
  const runner = createImportRunner();
  const connections = createConnections(runner);
  // Older versions collected diagnostics containing raw credentials.
  const ready = browser.storage.local.remove('__sctr_logs');

  void ready
    .then(async () => {
      const state = await readState();
      await scheduleHourly(Boolean(state.eat) && state.autoSync === true);
      if (state.job)
        void runner
          .sync()
          ?.catch(() => logStatus('error', 'Import will resume on the next alarm.'));
    })
    .catch(() => {});

  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== autoAlarm && alarm.name !== resumeAlarm) return;
    return ready.then(async () => {
      const state = await readState();
      if (alarm.name === resumeAlarm && !state.job) return browser.alarms.clear(resumeAlarm);
      if (alarm.name === resumeAlarm || (state.eat && state.autoSync === true)) {
        await runner
          .sync(alarm.name === autoAlarm)
          ?.catch(() => logStatus('error', 'Scheduled sync could not finish.'));
      }
    });
  });

  browser.runtime.onMessage.addListener((message, sender, reply) => {
    async function handle() {
      await ready;
      const action = message?.action || message?.type;
      const origin = dashboardOrigin(sender.url);
      const ownExtension = sender.id === browser.runtime.id;
      const dashboardTab =
        ownExtension &&
        sender.frameId === 0 &&
        origin &&
        (!sender.origin || sender.origin === origin);
      if (dashboardTab) {
        if (action === 'bridge-ping') return { ok: true };
        if (action === 'bridge-pair') return connections.queuePair(origin, message.code);
        if (action === 'bridge-revoke') return connections.refreshPair(origin);
      }
      // The Dashboard content bridge can propose an action. The installed popup owns confirmation.
      if (!ownExtension || !sender.url || !sender.url.startsWith(browser.runtime.getURL('/'))) {
        return { ok: false, error: 'forbidden' };
      }
      let state = await readState();
      if (action === 'getStatus' || action === 'get-status') {
        state = await connections.validateForStatus(state);
        return {
          paired: Boolean(state.eat),
          pairedAccountName: state.pairedAccountName,
          pendingPair: connections.visiblePair(state),
          pendingRsiAccount: state.pendingRsiAccount && {
            id: state.pendingRsiAccount.id,
            label: state.pendingRsiAccount.label,
          },
          rsiAccount: state.rsiAccount && { label: state.rsiAccount.label },
          syncing: Boolean(state.job || runner.busy()),
          lastSync: state.lastSync,
          progress: state.job && {
            current: state.job.next - 1,
            total: state.job.total,
            retryAt: state.job.retryAt,
            committing: state.job.phase === 'committing' || runner.committing(),
          },
          autoSync: state.autoSync === true,
          nextSync: (await browser.alarms.get(autoAlarm))?.scheduledTime,
          lastResult: state.lastResult,
          devMode: Boolean(state.devMode),
          debugEnabled: Boolean(state.debugEnabled),
          dashboardUrl: defaultOrigin(state.devMode),
          connectionBase: connectionOrigin(state),
          diagnostics: state.diagnostics || [],
        };
      }
      if (action === 'pair' || action === 'exchangeCode') {
        return connections.queuePair(
          defaultOrigin(state.devMode),
          message.code || message.payload?.code,
        );
      }
      if (action === 'confirm-pair') return connections.confirmPair(message.id);
      if (action === 'dismiss-pair') return connections.dismissPair(message.id);
      if (action === 'disconnect-current') return connections.disconnect();
      if (action === 'confirm-rsi-account') {
        if (!state.eat || !state.pendingRsiAccount || state.pendingRsiAccount.id !== message.id)
          return { ok: false, error: 'confirmation_expired' };
        const confirmed = await runner.changeConnection(async () => {
          const current = await readState();
          const pending = current.pendingRsiAccount;
          if (!current.eat || !pending || pending.id !== message.id)
            return { ok: false, error: 'confirmation_expired' };
          const salt = await accountSalt();
          try {
            const { account } = await fetchRsiPage(1, salt);
            if (account.accountKey !== pending.accountKey) {
              await browser.storage.local.set({
                pendingRsiAccount: { ...account, id: crypto.randomUUID() },
              });
              return { ok: false, error: 'account_changed' };
            }
            await browser.storage.local.set({ rsiAccount: account });
            await browser.storage.local.remove(['pendingRsiAccount', 'lastResult']);
            return { ok: true };
          } catch (err) {
            const error =
              err instanceof Error &&
              ['rsi_sign_in_required', 'rsi_account_unverified', 'rsi_page_unverified'].includes(
                err.message,
              )
                ? err.message
                : 'rsi_fetch_failed';
            return { ok: false, error };
          }
        });
        if (confirmed.ok)
          void runner.sync(true)?.catch(() => logStatus('error', 'Import could not start.'));
        return confirmed;
      }
      if (action === 'dismiss-rsi-account') {
        const pending = state.pendingRsiAccount;
        if (!pending || pending.id !== message.id)
          return { ok: false, error: 'confirmation_expired' };
        await browser.storage.local.remove('pendingRsiAccount');
        return { ok: true };
      }
      if (action === 'triggerSync' || action === 'manual-sync' || action === 'initial-sync') {
        if (!state.eat) return { ok: false, error: 'not_paired' };
        const importJob = runner.sync(true);
        if (!importJob) return { ok: false, error: 'import_busy' };
        void importJob.catch(() => logStatus('error', 'Import could not start.'));
        return { ok: true };
      }
      if (action === 'cancel-sync') return runner.changeConnection(async () => ({ ok: true }));
      if (action === 'set-settings') {
        const settings: Partial<StoredState> = {};
        if (typeof message.devMode === 'boolean') {
          settings.devMode = message.devMode;
          if (state.eat && !state.connectionBase)
            settings.connectionBase = defaultOrigin(state.devMode);
        }
        if (typeof message.debugEnabled === 'boolean') settings.debugEnabled = message.debugEnabled;
        if (typeof message.autoSync === 'boolean') settings.autoSync = message.autoSync;
        await browser.storage.local.set(settings);
        if (typeof settings.autoSync === 'boolean')
          await scheduleHourly(Boolean(state.eat) && settings.autoSync);
        return { ok: true };
      }
      if (action === 'clear-logs') {
        await browser.storage.local.remove('diagnostics');
        return { ok: true };
      }
      return { ok: false, error: 'unknown_action' };
    }
    void handle().then(reply, () => reply({ ok: false, error: 'internal_error' }));
    return true;
  });
});
