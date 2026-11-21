import { browserWarning } from '../utils/console';

const productionOrigin = 'https://citizenhangar.space';
const isDevelopment = process.env.CH_BUILD_PROFILE === 'development';
const matches = isDevelopment
  ? [productionOrigin + '/*', 'http://localhost/*', 'http://127.0.0.1/*']
  : [productionOrigin + '/*'];
const channels = ['CITIZEN_HANGAR_EXTENSION', 'SCTR_EXTENSION'];
const protocol = 2;
const errors = new Set([
  'confirmation_required',
  'invalid_code',
  'invalid_dashboard',
  'code_expired_or_invalid',
  'confirmation_expired',
  'extension_disabled',
  'import_busy',
  'network_error',
  'pair_pending',
  'rate_limited',
  'runtime_error',
]);

type BridgeCommand =
  { action: 'bridge-ping' } | { action: 'bridge-pair'; code: string } | { action: 'bridge-revoke' };
type BridgeResponse = { ok: boolean; error?: string; confirmationRequired?: true };
type ChromeRuntime = {
  sendMessage: (message: BridgeCommand, callback: (response: unknown) => void) => void;
  lastError?: unknown;
};

/** Use the browser API in the isolated world. Only controlled error codes cross to the page. */
async function sendCommand(command: BridgeCommand): Promise<unknown> {
  const runtime = globalThis as typeof globalThis & {
    browser?: { runtime?: { sendMessage: (message: BridgeCommand) => Promise<unknown> } };
    chrome?: { runtime?: ChromeRuntime };
  };
  if (runtime.browser?.runtime) return runtime.browser.runtime.sendMessage(command);

  const chrome = runtime.chrome?.runtime;
  if (!chrome) return { ok: false, error: 'runtime_error' };
  return new Promise((resolve) => {
    chrome.sendMessage(command, (response) => {
      resolve(chrome.lastError ? { ok: false, error: 'runtime_error' } : response);
    });
  });
}

/** Forward only the result fields needed for UI feedback. Credentials and identities stay isolated. */
function pageResponse(response: unknown): BridgeResponse {
  const value = response as {
    ok?: unknown;
    error?: unknown;
    confirmationRequired?: unknown;
  } | null;
  if (value?.ok === true) {
    return value.confirmationRequired === true
      ? { ok: true, confirmationRequired: true }
      : { ok: true };
  }
  const error =
    typeof value?.error === 'string' && errors.has(value.error) ? value.error : 'runtime_error';
  return { ok: false, error };
}

export default defineContentScript({
  matches,
  allFrames: false,
  main() {
    const pageOrigin = window.location.origin;
    const allowed =
      pageOrigin === productionOrigin ||
      (isDevelopment && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(pageOrigin));
    if (!allowed) return;

    // The two channel names support old listeners. Keep recently settled IDs as well as
    // active IDs to stop the redundant message from reaching the worker after a quick reply.
    const active = new Set<string>();
    const settled = new Set<string>();
    for (const source of channels)
      window.postMessage({ source, type: 'READY', protocol }, pageOrigin);

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window || event.origin !== pageOrigin) return;
      const data = event.data;
      if (!data || !channels.includes(data.target)) return;
      const { target, requestId, type } = data;
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(requestId)) return;
      if (active.has(requestId) || settled.has(requestId) || active.size >= 8) return;

      let command: BridgeCommand;
      let responseType: string;
      switch (type) {
        case 'PING':
          command = { action: 'bridge-ping' };
          responseType = 'PONG';
          break;
        case 'PAIR':
          command = { action: 'bridge-pair', code: data.payload?.code };
          responseType = 'PAIR_RESULT';
          break;
        case 'REVOKE':
          command = { action: 'bridge-revoke' };
          responseType = 'REVOKE_RESULT';
          break;
        default:
          return;
      }

      function reply(response: BridgeResponse) {
        window.postMessage(
          { source: target, type: responseType, protocol, requestId, response },
          pageOrigin,
        );
      }

      // Old Dashboards can still detect the add-on and use the manual popup form.
      // A legacy mutation request cannot bypass popup confirmation or scoped verification.
      if (type !== 'PING' && data.protocol !== protocol) {
        reply({ ok: false, error: 'confirmation_required' });
        return;
      }
      if (
        command.action === 'bridge-pair' &&
        (typeof command.code !== 'string' || !/^\d{6}$/.test(command.code))
      ) {
        reply({ ok: false, error: 'invalid_code' });
        return;
      }

      active.add(requestId);
      void sendCommand(command)
        .then(
          (response) => reply(pageResponse(response)),
          () => {
            browserWarning('The background worker did not respond.', 'runtime_error');
            reply({ ok: false, error: 'runtime_error' });
          },
        )
        .finally(() => {
          active.delete(requestId);
          settled.add(requestId);
          if (settled.size > 32) settled.delete(settled.values().next().value!);
        });
    });
  },
});
