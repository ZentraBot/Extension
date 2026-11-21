import { browserWarning } from '../utils/console';

const hostMatchesBase = ['https://citizenhangar.space/*'];
const isDev = process.env.CH_BUILD_PROFILE === 'development';
const matches = isDev
  ? [...hostMatchesBase, 'http://localhost/*', 'http://127.0.0.1/*']
  : hostMatchesBase;

export default defineContentScript({
  matches,
  main() {
    const runtime = (globalThis as any).browser?.runtime ?? (globalThis as any).chrome?.runtime;
    const CHANNEL_NAMES = ['CITIZEN_HANGAR_EXTENSION', 'SCTR_EXTENSION'];
    const READY_EVENTS = ['citizen-hangar-extension-ready', 'sctr-extension-ready'];
    const isAllowedOrigin = (origin: string) =>
      origin === 'https://citizenhangar.space' ||
      (isDev && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));

    /** Forward one validated Dashboard message using the runtime available in this browser. */
    function sendRuntimeMessage(payload: any) {
      // Helper: wait for a runtime to appear (browser or chrome) for up to `timeoutMs`.
      const waitForRuntime = (timeoutMs = 5000, pollMs = 100) => {
        const g = globalThis as any;
        if (g.browser?.runtime || g.chrome?.runtime) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          const start = Date.now();
          const id = setInterval(() => {
            if (g.browser?.runtime || g.chrome?.runtime) {
              clearInterval(id);
              resolve(true);
              return;
            }
            if (Date.now() - start >= timeoutMs) {
              clearInterval(id);
              resolve(false);
            }
          }, pollMs);
        });
      };

      // Attempt to use the Promise-based `browser.runtime` first; if not present, wait briefly for the runtime.
      return (async () => {
        const g = globalThis as any;
        if (g.browser && g.browser.runtime) {
          try {
            return await g.browser.runtime.sendMessage(payload);
          } catch (err) {
            browserWarning('The extension runtime rejected a Dashboard message', err);
            return { ok: false, error: err instanceof Error ? err.message : 'runtime_error' };
          }
        }

        const available = await waitForRuntime(5000, 100);
        if (!available) return { ok: false, error: 'no_runtime_available' };

        // If browser runtime appeared, use it.
        if (g.browser && g.browser.runtime) {
          try {
            return await g.browser.runtime.sendMessage(payload);
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : 'runtime_error' };
          }
        }

        // Otherwise use chrome.runtime (callback) wrapped into a Promise.
        return new Promise((resolve) => {
          try {
            g.chrome.runtime.sendMessage(payload, (response: any) => {
              const err = g.chrome && g.chrome.runtime && g.chrome.runtime.lastError;
              if (err) resolve({ ok: false, error: (err as any).message || 'runtime_error' });
              else resolve(response);
            });
          } catch (err) {
            resolve({ ok: false, error: err instanceof Error ? err.message : 'runtime_error' });
          }
        });
      })();
    }

    /** Send a bridge response back to the same origin that issued the request. */
    function reply(origin: string, payload: any, channel = CHANNEL_NAMES[0]) {
      try {
        window.postMessage({ source: channel, ...payload }, origin);
      } catch (_) {
        // ignore
      }
    }

    const pageOrigin = window.location.origin;
    let readyAnnounced = false;
    const activeRequests = new Set<string>();

    /** Announce both channel names once for compatibility with older Dashboard pages. */
    function announceReady() {
      if (readyAnnounced) return;
      if (!isAllowedOrigin(pageOrigin)) return;
      readyAnnounced = true;
      CHANNEL_NAMES.forEach((channel) => reply(pageOrigin, { type: 'READY' }, channel));
      READY_EVENTS.forEach((eventName) => {
        try {
          window.dispatchEvent(new CustomEvent(eventName, { detail: { origin: pageOrigin } }));
        } catch (_) {}
      });
    }

    announceReady();
    if (document.readyState === 'loading')
      document.addEventListener('DOMContentLoaded', announceReady);

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (!isAllowedOrigin(event.origin)) return;
      const { data } = event as any;
      if (!data || !CHANNEL_NAMES.includes(data.target)) return;

      const { requestId } = data;
      const channel = data.target;

      if (data.type === 'PING') {
        reply(event.origin, { type: 'PONG', requestId }, channel);
        return;
      }

      if (requestId && activeRequests.has(requestId)) return;
      if (requestId) activeRequests.add(requestId);

      const finalizeRequest = () => {
        if (requestId) activeRequests.delete(requestId);
      };

      if (data.type === 'PAIR' && data.payload && data.payload.code) {
        sendRuntimeMessage({
          action: 'pair',
          code: data.payload.code,
          baseUrl: data.payload.baseUrl,
          devMode: data.payload.devMode,
        })
          .then((response: any) =>
            reply(event.origin, { type: 'PAIR_RESULT', requestId, response }, channel),
          )
          .catch((error: any) =>
            reply(
              event.origin,
              {
                type: 'PAIR_RESULT',
                requestId,
                response: {
                  ok: false,
                  error: error && error.message ? error.message : 'runtime_error',
                },
              },
              channel,
            ),
          )
          .finally(finalizeRequest);
        return;
      }

      if (data.type === 'REVOKE') {
        sendRuntimeMessage({ action: 'revoke' })
          .then((response: any) =>
            reply(event.origin, { type: 'REVOKE_RESULT', requestId, response }, channel),
          )
          .catch((error: any) =>
            reply(
              event.origin,
              {
                type: 'REVOKE_RESULT',
                requestId,
                response: {
                  ok: false,
                  error: error && error.message ? error.message : 'runtime_error',
                },
              },
              channel,
            ),
          )
          .finally(finalizeRequest);
      }
      finalizeRequest();
    });
  },
});
