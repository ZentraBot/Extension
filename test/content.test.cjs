const assert = require('node:assert/strict');
const { createContext } = require('node:vm');
const { test } = require('node:test');
const { runEntry } = require('./compileEntry.cjs');

const productionOrigin = 'https://citizenhangar.space';
const channel = 'CITIZEN_HANGAR_EXTENSION';
const legacy = 'SCTR_EXTENSION';
const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Provide a same-window bridge and record messages without a browser install. */
function bridge({ origin = productionOrigin, profile = 'production', browser, chrome } = {}) {
  const posts = [];
  let listener;
  const window = {
    location: { origin },
    addEventListener(_name, handler) {
      listener = handler;
    },
    postMessage(message, target) {
      posts.push({ message, target });
    },
  };
  const context = createContext({
    window,
    browser,
    chrome,
    defineContentScript: (entry) => entry,
    process: { env: { CH_BUILD_PROFILE: profile } },
  });
  const entry = runEntry('entrypoints/content.ts', context);
  entry.main();
  return {
    entry,
    posts,
    message(type, fields = {}, event = {}) {
      listener?.({
        source: window,
        origin,
        data: { target: channel, requestId: 'req', type, protocol: 2, ...fields },
        ...event,
      });
    },
  };
}

test('content checks the worker for readiness and forwards only sanitized confirmation status', async () => {
  const commands = [];
  let finish;
  const fixture = bridge({
    browser: {
      runtime: {
        sendMessage(command) {
          commands.push(JSON.parse(JSON.stringify(command)));
          if (command.action === 'bridge-pair') {
            return new Promise((resolve) => {
              finish = resolve;
            });
          }
          return { ok: true, accountName: 'Private account' };
        },
      },
    },
  });
  assert.equal(fixture.entry.allFrames, false);
  assert.equal(fixture.posts.length, 2);
  assert.equal(fixture.posts[0].message.type, 'READY');
  assert.equal(fixture.posts[1].message.source, legacy);
  fixture.message('PING', { requestId: 'check' });
  await settle();
  assert.equal(fixture.posts.at(-1).message.type, 'PONG');
  assert.equal(fixture.posts.at(-1).message.protocol, 2);
  assert.deepEqual(commands, [{ action: 'bridge-ping' }]);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.posts.at(-1).message.response)), { ok: true });

  const payload = { code: '123456', baseUrl: 'https://wrong.example', accountName: 'Untrusted' };
  fixture.message('PAIR', { payload }, { origin: 'https://other.example' });
  fixture.message('PAIR', { payload }, { source: {} });
  fixture.message('PAIR', { payload, target: 'unknown' });
  fixture.message('PAIR', {}, { data: null });
  fixture.message('PAIR', { payload, requestId: [] });
  fixture.message('UNKNOWN');
  assert.equal(commands.length, 1);

  fixture.message('PAIR', { payload });
  fixture.message('PAIR', { payload, target: legacy });
  assert.deepEqual(commands.at(-1), { action: 'bridge-pair', code: '123456' });
  assert.equal(commands.length, 2);
  finish({ ok: true, confirmationRequired: true, eat: 'secret', accountName: 'Private account' });
  await settle();
  fixture.message('PAIR', { payload, target: legacy });
  assert.equal(commands.length, 2);
  assert.equal(fixture.posts.at(-1).message.type, 'PAIR_RESULT');
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.posts.at(-1).message.response)), {
    ok: true,
    confirmationRequired: true,
  });

  fixture.message('REVOKE', { requestId: 'revoke' });
  fixture.message('REVOKE', { requestId: 'revoke', target: legacy });
  await settle();
  fixture.message('REVOKE', { requestId: 'revoke', target: legacy });
  assert.deepEqual(commands.at(-1), { action: 'bridge-revoke' });
  assert.equal(commands.length, 3);
  assert.equal(fixture.posts.at(-1).message.type, 'REVOKE_RESULT');
});

test('legacy bridge mutations are refused and development origins remain scoped to their own page', async () => {
  const production = bridge({ origin: 'http://localhost:3000' });
  assert.equal(production.posts.length, 0);
  let requests = 0;
  const development = bridge({
    origin: 'http://localhost:3000',
    profile: 'development',
    browser: {
      runtime: {
        sendMessage() {
          requests += 1;
          return { ok: false, error: 'pair_pending', debug: 'sensitive' };
        },
      },
    },
  });
  assert.ok(development.entry.matches.includes('http://localhost/*'));
  development.message('REVOKE', { protocol: undefined });
  assert.equal(development.posts.at(-1).message.response.error, 'confirmation_required');
  development.message('PAIR', { payload: { code: 'bad' } });
  assert.equal(development.posts.at(-1).message.response.error, 'invalid_code');
  development.message('PAIR');
  assert.equal(development.posts.at(-1).message.response.error, 'invalid_code');
  development.message('PAIR', { payload: { code: '123456' } }, { origin: productionOrigin });
  assert.equal(requests, 0);
  development.message('PAIR', { payload: { code: '123456' } });
  await settle();
  assert.deepEqual(JSON.parse(JSON.stringify(development.posts.at(-1).message.response)), {
    ok: false,
    error: 'pair_pending',
  });
  assert.equal(development.posts.at(-1).target, 'http://localhost:3000');
});

test('runtime failures and unknown reply fields are redacted across browsers', async () => {
  const runtime = {
    lastError: { message: 'Private message' },
    sendMessage(_command, callback) {
      callback({ ok: true });
    },
  };
  const firefox = bridge({
    browser: {
      runtime: {
        sendMessage() {
          throw new Error('Unexpected private error');
        },
      },
    },
  });
  const chrome = bridge({ chrome: { runtime } });
  const absent = bridge();
  for (const fixture of [chrome, absent, firefox]) {
    fixture.message('PING');
    await settle();
    assert.equal(fixture.posts.at(-1).message.response.error, 'runtime_error');
  }
  runtime.lastError = undefined;
  chrome.message('PING', { requestId: 'next' });
  await settle();
  assert.equal(chrome.posts.at(-1).message.response.ok, true);

  runtime.sendMessage = (_command, callback) => callback({ ok: false, error: 'private' });
  chrome.message('PING', { requestId: 'malformed' });
  await settle();
  assert.equal(chrome.posts.at(-1).message.response.error, 'runtime_error');
  runtime.sendMessage = () => {
    throw new Error('Runtime rejected');
  };
  chrome.message('PING', { requestId: 'throw' });
  await settle();
  assert.equal(chrome.posts.at(-1).message.response.error, 'runtime_error');
});

test('the bridge bounds pending work and trims completed request identifiers', async () => {
  const queue = [];
  const fixture = bridge({
    browser: { runtime: { sendMessage: () => new Promise((resolve) => queue.push(resolve)) } },
  });
  for (let index = 0; index < 9; index += 1) fixture.message('PING', { requestId: 'req-' + index });
  assert.equal(queue.length, 8);
  for (const reply of queue.splice(0)) reply({ ok: true });
  await settle();
  for (let index = 9; index < 35; index += 1) {
    fixture.message('PING', { requestId: 'req-' + index });
    queue.shift()(undefined);
    await settle();
  }
  fixture.message('PING', { requestId: 'req-0' });
  assert.equal(queue.length, 1);
  queue.shift()({ ok: true });
  await settle();
});
