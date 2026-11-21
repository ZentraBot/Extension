const assert = require('node:assert/strict');
const { createContext } = require('node:vm');
const { test } = require('node:test');
const { runEntry } = require('./compileEntry.cjs');

const productionOrigin = 'https://citizenhangar.space';
const channel = 'CITIZEN_HANGAR_EXTENSION';
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Record page messages without forwarding them back through the real browser. */
function bridge({
  origin = productionOrigin,
  profile = 'production',
  browser,
  chrome,
  warn = () => {},
} = {}) {
  const posts = [];
  const events = [];
  let listener;
  let ready;
  let interval;
  let clock = 0;
  const window = {
    location: { origin },
    addEventListener(_name, handler) {
      listener = handler;
    },
    dispatchEvent(event) {
      events.push(event);
    },
    postMessage(message, target) {
      posts.push({ message, target });
    },
  };
  const context = createContext({
    window,
    browser,
    chrome,
    Error,
    URL,
    CustomEvent,
    Date: { now: () => clock },
    document: {
      readyState: 'loading',
      addEventListener(_name, handler) {
        ready = handler;
      },
    },
    setInterval(callback) {
      interval = callback;
      return 1;
    },
    clearInterval() {},
    defineContentScript: (entry) => entry,
    process: { env: { CH_BUILD_PROFILE: profile } },
    require() {
      return { browserWarning: warn };
    },
  });
  const entry = runEntry('entrypoints/content.ts', context);
  entry.main();
  return {
    context,
    entry,
    posts,
    events,
    ready,
    tick(milliseconds) {
      clock += milliseconds;
      interval();
    },
    message(type, data = {}, event = {}) {
      listener({
        source: window,
        origin,
        data: { target: channel, requestId: 'req', type, ...data },
        ...event,
      });
    },
  };
}

test('content announces readiness once and accepts messages from its own allowed page', async () => {
  let calls = 0;
  let finish;
  const fixture = bridge({
    browser: {
      runtime: {
        sendMessage(message) {
          calls += 1;
          if (message.action === 'pair')
            return new Promise((resolve) => {
              finish = resolve;
            });
          return { ok: true };
        },
      },
    },
  });
  assert.equal(fixture.posts.length, 2);
  assert.equal(fixture.events.length, 2);
  fixture.ready();
  assert.equal(fixture.posts.length, 2);
  fixture.message('PING');
  assert.equal(fixture.posts.at(-1).message.type, 'PONG');
  fixture.message('PAIR', { payload: { code: '123456' } }, { origin: 'https://other.example' });
  fixture.message('PAIR', { payload: { code: '123456' } }, { source: {} });
  assert.equal(calls, 0);
  fixture.message('PAIR', { payload: { code: '123456' } });
  fixture.message('PAIR', { payload: { code: '123456' } });
  assert.equal(calls, 1);
  finish({ ok: true });
  await settle();
  assert.equal(fixture.posts.at(-1).message.type, 'PAIR_RESULT');
  fixture.message('REVOKE');
  await settle();
  assert.equal(fixture.posts.at(-1).message.type, 'REVOKE_RESULT');
});

test('content handles Chrome callback errors and late or missing runtimes', async () => {
  const runtime = {
    lastError: { message: 'Runtime unavailable' },
    sendMessage(_message, callback) {
      callback({ ok: true });
    },
  };
  const callbacks = bridge({ chrome: { runtime } });
  callbacks.message('REVOKE');
  await settle();
  assert.equal(callbacks.posts.at(-1).message.response.error, 'Runtime unavailable');
  runtime.lastError = undefined;
  callbacks.message('REVOKE');
  await settle();
  assert.equal(callbacks.posts.at(-1).message.response.ok, true);

  const missing = bridge();
  missing.message('REVOKE');
  missing.tick(5000);
  await settle();
  assert.equal(missing.posts.at(-1).message.response.error, 'no_runtime_available');

  const late = bridge();
  late.message('REVOKE');
  late.context.browser = { runtime: { sendMessage: async () => ({ ok: true }) } };
  late.tick(100);
  await settle();
  assert.equal(late.posts.at(-1).message.response.ok, true);
});

test('content permits loopback only in development and reports rejected promises', async () => {
  const prod = bridge({ origin: 'http://localhost:3000' });
  assert.equal(prod.posts.length, 0);
  const warnings = [];
  const dev = bridge({
    origin: 'http://localhost:3000',
    profile: 'development',
    warn: (...args) => warnings.push(args),
    browser: {
      runtime: {
        sendMessage: async () => {
          throw new Error('Offline');
        },
      },
    },
  });
  assert.ok(dev.entry.matches.includes('http://localhost/*'));
  dev.message('REVOKE', { target: 'unknown' });
  dev.message('REVOKE');
  await settle();
  assert.equal(dev.posts.at(-1).message.response.error, 'Offline');
  assert.equal(warnings.length, 1);
});

test('late runtime failures and synchronous Chrome errors return diagnostic codes', async () => {
  const errors = bridge();
  errors.message('REVOKE');
  errors.context.browser = {
    runtime: {
      sendMessage: async () => {
        throw 'Rejected without an Error';
      },
    },
  };
  errors.tick(100);
  await settle();
  assert.equal(errors.posts.at(-1).message.response.error, 'runtime_error');

  const thrower = bridge({
    chrome: {
      runtime: {
        sendMessage() {
          throw Error('Callback failed');
        },
      },
    },
  });
  thrower.message('REVOKE');
  await settle();
  assert.equal(thrower.posts.at(-1).message.response.error, 'Callback failed');
  thrower.context.chrome.runtime.sendMessage = (_message, callback) => {
    callback({ ok: true });
  };
  thrower.context.chrome.runtime.lastError = {};
  thrower.message('REVOKE');
  await settle();
  assert.equal(thrower.posts.at(-1).message.response.error, 'runtime_error');
  thrower.message('IGNORED', { requestId: undefined });
});
