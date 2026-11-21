const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext } = require('node:vm');
const { runEntry } = require('./compileEntry.cjs');

function fixture(profile, fetch) {
  return runEntry(
    'utils/extensionApi.ts',
    createContext({ process: { env: { CH_BUILD_PROFILE: profile } }, fetch, URL, AbortSignal }),
  );
}

test('production requests stay on the Dashboard and development connections stay on their selected loopback', () => {
  const production = fixture('production');
  const development = fixture('development');
  const origin = 'https://citizenhangar.space';
  assert.equal(production.dashboardOrigin(`${origin}/link`), origin);
  for (const address of [
    undefined,
    '/link',
    'https://pilot@citizenhangar.space',
    'https://citizenhangar.space:1234',
    'http://citizenhangar.space',
    'http://localhost:3000',
    'https://another.example.test',
  ])
    assert.equal(production.dashboardOrigin(address), undefined);
  assert.equal(production.defaultOrigin(true), origin);
  assert.equal(development.dashboardOrigin('http://127.0.0.1:4311/link'), 'http://127.0.0.1:4311');
  assert.equal(development.dashboardOrigin('http://localhost:4321'), 'http://localhost:4321');
  assert.equal(development.dashboardOrigin('https://localhost:4321'), undefined);
  assert.equal(development.dashboardOrigin('http://another.example.test'), undefined);
  assert.equal(development.defaultOrigin(true), 'http://localhost:3000');
  assert.equal(development.defaultOrigin(false), origin);
  assert.equal(development.connectionOrigin({ devMode: true, connectionBase: origin }), origin);
  assert.equal(
    development.connectionOrigin({ devMode: true, connectionBase: 'malformed' }),
    'http://localhost:3000',
  );
});

test('API requests omit cookies, reject redirects, preserve cancellation, and classify response failures', async () => {
  let received;
  let reply = Response.json({ ok: true });
  const { apiRequest, prodOrigin, credentialPath } = fixture(
    'production',
    async (target, options) => {
      received = { target, options };
      if (reply instanceof Error) throw reply;
      return reply;
    },
  );
  const controller = new AbortController();
  const rotate = await apiRequest(
    prodOrigin,
    credentialPath,
    'PUT',
    { replacement: 'fixture' },
    'local-token',
    controller.signal,
  );
  assert.equal(rotate.ok, true);
  assert.equal(received.target, prodOrigin + credentialPath);
  const { method, credentials, cache, redirect, headers, body, signal } = received.options;
  assert.equal(method, 'PUT');
  assert.equal(credentials, 'omit');
  assert.equal(cache, 'no-store');
  assert.equal(redirect, 'error');
  assert.equal(headers.Authorization, 'Bearer local-token');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(body), { replacement: 'fixture' });
  controller.abort();
  assert.equal(signal.aborted, true);

  reply = new Response(null, { status: 204 });
  assert.equal((await apiRequest(prodOrigin, credentialPath, 'DELETE')).ok, true);
  assert.equal('body' in received.options, false);
  assert.equal('Authorization' in received.options.headers, false);
  for (const [fixtureResponse, token, expected] of [
    [new Response(null, { status: 429 }), undefined, 'network_error'],
    [new Response(null, { status: 503 }), undefined, 'network_error'],
    [new Response(null, { status: 401 }), 'local-token', 'invalid_eat'],
    [Response.json({ error: 'invalid_code' }, { status: 401 }), undefined, 'invalid_code'],
    [new Response(null, { status: 404 }), undefined, 'unsupported_format'],
    [Response.json(null), undefined, 'invalid_response'],
    [Response.json('wrong shape'), undefined, 'invalid_response'],
    [Response.json([]), undefined, 'invalid_response'],
    [new Response('not JSON'), undefined, 'network_error'],
    [new Error('fixture disconnected'), undefined, 'network_error'],
  ]) {
    reply = fixtureResponse;
    const failure = await apiRequest(prodOrigin, credentialPath, 'GET', undefined, token);
    assert.equal(failure.ok, false);
    assert.equal(failure.error, expected);
  }
});
