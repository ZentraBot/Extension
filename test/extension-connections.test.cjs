const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext } = require('node:vm');
const { webcrypto } = require('node:crypto');
const { runEntry } = require('./compileEntry.cjs');

const origin = 'https://citizenhangar.space';

function fixture(state, exchange) {
  const removedAlarms = [];
  const browser = {
    storage: {
      local: {
        get: async () => structuredClone(state),
        set: async (values) => Object.assign(state, structuredClone(values)),
        remove: async (keys) => {
          for (const key of [].concat(keys)) delete state[key];
        },
      },
    },
    alarms: { clear: async (alarm) => removedAlarms.push(alarm) },
  };
  const { createConnections } = runEntry(
    'utils/extensionConnections.ts',
    createContext({
      URL,
      AbortSignal,
      browser,
      fetch: exchange,
      crypto: webcrypto,
      process: { env: { CH_BUILD_PROFILE: 'production' } },
    }),
  );
  const connections = createConnections({
    busy: () => false,
    changeConnection: (action) => action(),
  });
  return { connections, removedAlarms };
}

test('offline disconnect preserves the binding until the credential is revoked or confirmed invalid', async () => {
  const state = {
    eat: 'fixture-current-token',
    connectionBase: origin,
    pairedAccountName: 'Current pilot',
  };
  let response = new Response(null, { status: 503 });
  const requests = [];
  const { connections, removedAlarms } = fixture(state, async (url, options) => {
    requests.push({ url, method: options.method });
    return response;
  });
  const offline = await connections.disconnect();
  assert.equal(offline.ok, false);
  assert.equal(offline.error, 'network_error');
  assert.equal(state.eat, 'fixture-current-token');
  assert.equal(removedAlarms.length, 0);
  response = new Response(null, { status: 401 });
  assert.equal((await connections.disconnect()).ok, true);
  assert.equal(state.eat, undefined);
  assert.deepEqual(removedAlarms, ['hourlySync']);
  assert.equal((await connections.disconnect()).ok, true);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.url, origin + '/api/extension/v2/credential');
    assert.equal(request.method, 'DELETE');
  }
});

test('pairing preview requires current account metadata and refresh accepts optional device metadata', async () => {
  const state = { eat: 'fixture-current-token', pairedAccountName: 'Existing pilot' };
  let response;
  const { connections } = fixture(state, async () => response);
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  for (const preview of [
    { accountName: 'Missing identifier', expiresAt },
    { accountId: 'pilot', expiresAt },
    { accountId: 'pilot', accountName: 'Missing expiry' },
    { accountId: 'pilot', accountName: 'Expired', expiresAt: '2020-01-01T00:00:00Z' },
  ]) {
    response = Response.json(preview);
    const result = await connections.queuePair(origin, '123456');
    assert.equal(result.ok, false);
    assert.equal(result.error, 'invalid_response');
    assert.equal(state.pendingPair, undefined);
  }
  response = Response.json({ ok: true });
  assert.equal((await connections.refreshPair(origin)).ok, true);
  assert.equal(state.pairedAccountName, 'Existing pilot');
  assert.equal(state.eat, 'fixture-current-token');
  assert.equal(state.expiresAt, undefined);
});
