const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext } = require('node:vm');
const { createHash, webcrypto } = require('node:crypto');
const { runEntry } = require('./compileEntry.cjs');

const dashboard = 'https://citizenhangar.space';
const rsi = 'https://robertsspaceindustries.com';
const popup = { id: 'fixture', url: 'moz-extension://fixture/popup.html' };
const tab = { id: 'fixture', frameId: 0, url: dashboard + '/?view=extension', origin: dashboard };
const salt = 'test-rsi-salt';
const keyOf = (handle) =>
  createHash('sha256').update(`${salt}\0handle:${handle.toLowerCase()}`).digest('hex');
const pilot = { accountKey: keyOf('Pilot'), label: '@Pilot' };
const connection = {
  eat: 'paired-token',
  pairedAccountName: 'Hangar Pilot',
  autoSync: false,
  rsiSalt: salt,
  rsiAccount: pilot,
};
const opened = (next = 1, total = next) => Response.json({ ok: true, next, total });
const noContent = () => new Response(null, { status: 204 });
const restored = (extra = {}) => ({
  reference: 'restored',
  format: 2,
  accountKey: pilot.accountKey,
  next: 1,
  total: 1,
  retries: 0,
  started: Date.now(),
  ...extra,
});

function documentFor({ page = 1, total = page, handle = 'Pilot', signedIn = true } = {}) {
  const props = JSON.stringify({
    user: { isSignedIn: signedIn, handle, xsrfToken: 'local-fixture-only' },
  }).replace(/"/g, '&quot;');
  return new Response(`<div data-platform-client-props="${props}"></div>
    <link rel="canonical" href="${rsi}/account/pledges?page=${page}">
    <ul class="list-items"><li><input class="js-pledge-id" value="pledge-${page}"><input class="js-pledge-name" value="Ship ${page}"></li></ul>
    <nav class="pager"><a href = '?page=${total}'>${total}</a></nav>`);
}

function fixtures(state, upstream, { now = Date.now(), profile = 'production' } = {}) {
  const alarms = new Map();
  let handler;
  let onAlarm;
  class TestDate extends Date {
    static now() {
      return now;
    }
  }
  const browser = {
    runtime: {
      id: 'fixture',
      getURL: (path) => 'moz-extension://fixture' + path,
      getManifest: () => ({ version: '1.4.0' }),
      onMessage: {
        addListener: (listen) => {
          handler = listen;
        },
      },
    },
    storage: {
      local: {
        get: async (keys) =>
          Object.fromEntries(
            keys.filter((key) => key in state).map((key) => [key, structuredClone(state[key])]),
          ),
        set: async (values) => Object.assign(state, structuredClone(values)),
        remove: async (keys) => {
          for (const key of [].concat(keys)) delete state[key];
        },
      },
    },
    alarms: {
      create: async (name, { periodInMinutes }) =>
        alarms.set(name, { name, scheduledTime: now + periodInMinutes * 60000 }),
      get: async (name) => alarms.get(name),
      clear: async (name) => alarms.delete(name),
      onAlarm: {
        addListener: (callback) => {
          onAlarm = callback;
        },
      },
    },
  };
  const initialise = runEntry(
    'entrypoints/background.ts',
    createContext({
      defineBackground: (callback) => callback,
      process: { env: { CH_BUILD_PROFILE: profile } },
      Date: TestDate,
      browser,
      console,
      URL,
      AbortSignal,
      AbortController,
      TextDecoder,
      TextEncoder,
      fetch: upstream,
      crypto: webcrypto,
      navigator: { userAgent: profile === 'development' ? 'Fixture Firefox' : 'Fixture Chromium' },
    }),
  );
  initialise();
  return {
    message: (type, extra = {}, sender = popup) =>
      new Promise((resolve) => handler({ type, ...extra }, sender, resolve)),
    alarm: (name) => onAlarm({ name }),
    advance: (milliseconds) => {
      now += milliseconds;
    },
    alarms,
  };
}

async function waitUntil(predicate) {
  for (let index = 0; index < 150; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected the background job to reach its next state');
}

test('first sync captures a visible account proposal and uploads typed pledges only after approval', async () => {
  const state = { ...connection, rsiAccount: undefined };
  const payloads = [];
  let handle = 'Pilot';
  const worker = fixtures(state, (url, options) => {
    if (url.startsWith(rsi)) return documentFor({ handle });
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    const payload = JSON.parse(options.body);
    payloads.push(payload);
    if (url.endsWith('/complete')) return Response.json({ ok: true, outcome: 'success' });
    if (url.includes('/pages/')) return Response.json({ ok: true });
    return opened();
  });
  await worker.message('triggerSync');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'rsi_account_confirmation_required');
  assert.equal(payloads.length, 0);
  let visible = (await worker.message('getStatus')).pendingRsiAccount;
  assert.equal(visible.label, '@Pilot');
  assert.equal(visible.accountKey, undefined);
  assert.equal(
    (await worker.message('confirm-rsi-account', { id: 'stale' })).error,
    'confirmation_expired',
  );
  handle = 'Other';
  assert.equal(
    (await worker.message('confirm-rsi-account', { id: visible.id })).error,
    'account_changed',
  );
  visible = (await worker.message('getStatus')).pendingRsiAccount;
  assert.equal(visible.label, '@Other');
  assert.equal((await worker.message('dismiss-rsi-account', { id: visible.id })).ok, true);
  handle = 'Pilot';
  await worker.message('manual-sync');
  await waitUntil(() => state.pendingRsiAccount);
  visible = (await worker.message('getStatus')).pendingRsiAccount;
  assert.equal((await worker.message('confirm-rsi-account', { id: visible.id })).ok, true);
  await waitUntil(() => state.lastResult?.ok);
  assert.equal((await worker.message('getStatus')).rsiAccount.label, '@Pilot');
  assert.deepEqual(payloads[0], { format: 2 });
  assert.deepEqual(payloads[1].source, { page: 1, accountKey: pilot.accountKey });
  assert.equal(payloads[1].pledges[0].name, 'Ship 1');
  assert.equal(payloads[1].empty, false);
  assert.doesNotMatch(JSON.stringify(payloads), /local-fixture-only|<input|@Pilot/);
  assert.equal(payloads[2].pageCount, 1);
});

test('an RSI account switch during a multi-page import records failure without uploading the new account', async () => {
  const state = { ...connection, lastSync: 42 };
  const uploaded = [];
  const worker = fixtures(state, (url, { body }) => {
    if (url.startsWith(rsi)) {
      const page = Number(new URL(url).searchParams.get('page'));
      return documentFor({ page, total: 2, handle: page === 1 ? 'Pilot' : 'Other' });
    }
    if (url.includes('/pages/')) {
      uploaded.push(JSON.parse(body));
      return Response.json({ ok: true });
    }
    if (url.endsWith('/complete')) {
      assert.equal(JSON.parse(body).issue, 'account_changed');
      return Response.json({ error: 'account_changed', outcome: 'failed' }, { status: 422 });
    }
    return opened();
  });
  await worker.message('manual-sync');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'account_changed');
  assert.equal(state.lastSync, 42);
  assert.equal(uploaded.length, 1);
  assert.equal(state.pendingRsiAccount.label, '@Other');
  assert.equal(state.rsiAccount.label, '@Pilot');
});

test('restart recreates a missing retry alarm before backoff and follows server checkpoints', async () => {
  const now = Date.now();
  const state = {
    ...connection,
    job: restored({ next: 2, total: 3, retries: 1, retryAt: now + 60000 }),
  };
  let attempts = 0;
  const worker = fixtures(
    state,
    (url, { body }) => {
      if (url.startsWith(rsi)) {
        assert.equal(new URL(url).searchParams.get('page'), '3');
        attempts += 1;
        return attempts === 1 ? new Response('', { status: 503 }) : documentFor({ page: 3 });
      }
      if (url.includes('/pages/')) return Response.json({ ok: true });
      if (url.endsWith('/complete')) {
        assert.equal(JSON.parse(body).pageCount, 3);
        return Response.json({ ok: true });
      }
      return opened(3, 3);
    },
    { now },
  );
  await waitUntil(() => worker.alarms.has('resumeHangarImport'));
  assert.equal(attempts, 0);
  assert.equal((await worker.message('get-status')).nextSync, undefined);
  await worker.alarm('unrelated');
  await worker.alarm('hourlySync');
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(attempts, 1);
  assert.equal(state.job.retries, 1);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(state.lastResult.ok, true);
  assert.equal(state.job, undefined);
  await worker.alarm('resumeHangarImport');
  assert.equal(worker.alarms.has('resumeHangarImport'), false);
});

test('cancelling a collection aborts fetches and retries deleting the draft without publishing', async () => {
  const state = { ...connection, job: restored(), lastSync: 100 };
  let collecting = false;
  let deleting = 0;
  const worker = fixtures(state, (url, { method, signal }) => {
    if (url.startsWith(rsi)) {
      collecting = true;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
    assert.ok(!url.endsWith('/complete'));
    if (method === 'DELETE') {
      deleting += 1;
      return deleting === 1 ? new Response('', { status: 503 }) : noContent();
    }
    return opened();
  });
  await waitUntil(() => collecting);
  assert.equal((await worker.message('cancel-sync')).error, 'cancel_pending');
  assert.equal(state.job.phase, 'cancelling');
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(state.job, undefined);
  assert.equal(deleting, 2);
  assert.equal(state.lastSync, 100);
});

test('a sealed publish blocks cancel, disconnect and confirmed re-pair without consuming a code', async () => {
  const state = {
    ...connection,
    job: restored({ phase: 'committing', next: 2, retries: 3 }),
    pendingPair: {
      id: 'pending',
      code: '123456',
      origin: dashboard,
      accountName: 'Next Pilot',
      accountId: 'next',
      expiresAt: new Date(Date.now() + 30000).toISOString(),
    },
  };
  let release;
  const worker = fixtures(state, (url) => {
    assert.doesNotMatch(url, /\/pair$/);
    if (url.endsWith('/complete'))
      return new Promise((resolve) => {
        release = resolve;
      });
    return opened(2, 1);
  });
  await waitUntil(() => release);
  assert.equal((await worker.message('cancel-sync')).error, 'import_busy');
  assert.equal((await worker.message('disconnect-current')).error, 'import_busy');
  assert.equal((await worker.message('confirm-pair', { id: 'pending' })).error, 'import_busy');
  assert.equal((await worker.message('getStatus')).progress.committing, true);
  release(new Response('', { status: 429 }));
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'network_error');
});

test('pairing shows the Dashboard identity, binds redemption to it, and verifies browser disconnect', async () => {
  const state = { autoSync: false, __sctr_logs: ['discarded'] };
  const account = {
    accountName: 'Hangar Pilot',
    accountId: 'pilot',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  let redeemed = 0;
  let deleted = 0;
  let revoked = false;
  const worker = fixtures(
    state,
    (url, { method, body, headers }) => {
      if (url.endsWith('/pair/preview')) {
        const { code } = JSON.parse(body);
        if (code === '000001')
          return Response.json({ error: 'code_expired_or_invalid' }, { status: 400 });
        if (code === '000002') return Response.json({ accountName: 'Incomplete' });
        return Response.json({
          ...account,
          accountName: code === '123457' ? 'Other pilot' : account.accountName,
        });
      }
      if (url.endsWith('/pair')) {
        redeemed += 1;
        assert.equal(JSON.parse(body).expectedAccountId, account.accountId);
        assert.match(JSON.parse(body).label, /Firefox/);
        return Response.json({ ...account, eat: 'new-token' });
      }
      assert.equal(headers.Authorization, 'Bearer new-token');
      if (method === 'GET')
        return revoked ? new Response('', { status: 401 }) : Response.json(account);
      deleted += 1;
      return noContent();
    },
    { profile: 'development' },
  );
  assert.equal((await worker.message('bridge-ping', {}, tab)).ok, true);
  assert.equal(
    (await worker.message('bridge-ping', {}, { ...tab, frameId: 1 })).error,
    'forbidden',
  );
  assert.equal(
    (await worker.message('bridge-ping', {}, { ...tab, origin: 'https://other.example.test' }))
      .error,
    'forbidden',
  );
  for (const url of [
    'https://other.example/',
    'invalid',
    'https://name:password@citizenhangar.space',
  ]) {
    assert.equal(
      (await worker.message('bridge-pair', { code: '123456' }, { ...tab, url })).error,
      'forbidden',
    );
  }
  assert.equal((await worker.message('triggerSync')).error, 'not_paired');
  assert.equal((await worker.message('pair', { code: 'incorrect' })).error, 'invalid_code');
  assert.equal((await worker.message('pair', { code: '000001' })).error, 'code_expired_or_invalid');
  assert.equal((await worker.message('pair', { code: '000002' })).error, 'invalid_response');
  assert.equal(
    (await worker.message('set-settings', { devMode: true, debugEnabled: true, autoSync: true }))
      .ok,
    true,
  );
  assert.match((await worker.message('getStatus')).dashboardUrl, /localhost/);
  assert.equal((await worker.message('getStatus')).nextSync, undefined);
  assert.equal(
    (await worker.message('bridge-pair', { code: '123457' }, tab)).confirmationRequired,
    true,
  );
  const stale = (await worker.message('getStatus')).pendingPair;
  assert.equal(stale.accountName, 'Other pilot');
  assert.equal(stale.code, undefined);
  assert.equal(
    (await worker.message('exchangeCode', { payload: { code: '123456' } })).confirmationRequired,
    true,
  );
  const visible = (await worker.message('getStatus')).pendingPair;
  assert.equal(visible.accountName, 'Hangar Pilot');
  assert.equal(
    (await worker.message('confirm-pair', { id: stale.id })).error,
    'confirmation_expired',
  );
  assert.equal((await worker.message('confirm-pair', { id: visible.id }, tab)).error, 'forbidden');
  assert.equal(redeemed, 0);
  assert.equal((await worker.message('dismiss-pair', { id: visible.id })).ok, true);
  await worker.message('bridge-pair', { code: '123456' }, tab);
  assert.equal((await worker.message('confirm-pair', { id: state.pendingPair.id })).ok, true);
  assert.equal(state.eat, 'new-token');
  assert.ok((await worker.message('getStatus')).nextSync);
  assert.equal(state.__sctr_logs, undefined);
  assert.equal(state.diagnostics[0].msg, 'Browser paired.');
  assert.equal((await worker.message('bridge-revoke', {}, tab)).ok, true);
  assert.equal(state.eat, 'new-token');
  revoked = true;
  assert.equal((await worker.message('bridge-revoke', {}, tab)).ok, true);
  assert.equal(state.eat, undefined);
  await worker.message('bridge-pair', { code: '123456' }, tab);
  await worker.message('confirm-pair', { id: state.pendingPair.id });
  assert.equal((await worker.message('disconnect-current')).ok, true);
  assert.equal(deleted, 1);
  assert.equal(state.eat, undefined);
  assert.equal((await worker.message('clear-logs')).ok, true);
  assert.equal(state.diagnostics, undefined);
  assert.equal((await worker.message('unknown')).error, 'unknown_action');
});

test('rotation reuses a durable proposed credential and preserves observed account state', async () => {
  const state = { ...connection, pendingCredential: 'durable', job: restored() };
  let rotations = 0;
  const worker = fixtures(state, (url, { headers, body }) => {
    if (url.endsWith('/credential')) {
      rotations += 1;
      assert.equal(JSON.parse(body).replacement, 'durable');
      assert.equal(state.pendingCredential, 'durable');
      assert.equal(headers.Authorization, 'Bearer paired-token');
      if (rotations === 1) throw Error('Network offline');
      return Response.json({ ok: true, expiresAt: '2030-01-01' });
    }
    assert.equal(headers.Authorization, 'Bearer durable');
    return Response.json({ ok: true, outcome: 'success', reference: 'previous-commit' });
  });
  await waitUntil(() => state.job?.retryAt);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(state.lastResult.ok, true);
  assert.equal(state.eat, 'durable');
  assert.equal(state.pendingCredential, null);
  assert.equal(state.rsiAccount.label, '@Pilot');
});

test('stale and legacy drafts never upload and invalid credentials drop the pairing', async () => {
  const stale = { ...connection, job: restored({ started: Date.now() - 3600001 }) };
  fixtures(stale, () => {
    throw Error('Expired import must not make a request');
  });
  await waitUntil(() => stale.lastResult);
  assert.equal(stale.lastResult.error, 'import_expired');
  const legacy = { ...connection, job: restored({ format: undefined }) };
  let draftsRemoved = 0;
  fixtures(legacy, (_url, { method }) => {
    assert.equal(method, 'DELETE');
    draftsRemoved += 1;
    return noContent();
  });
  await waitUntil(() => !legacy.job);
  assert.equal(draftsRemoved, 1);
  const revoked = { ...connection, autoSync: true, lastSync: 55, job: restored() };
  fixtures(revoked, () => new Response('', { status: 401 }));
  await waitUntil(() => revoked.lastResult);
  assert.equal(revoked.eat, undefined);
  assert.equal(revoked.lastSync, undefined);
  assert.equal(revoked.lastResult.error, 'invalid_eat');
});

test('signed-out collection uses distinct recovery and retains last success', async () => {
  const state = { ...connection, lastSync: 30 };
  const worker = fixtures(state, () => documentFor({ signedIn: false }));
  await worker.message('initial-sync');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'rsi_sign_in_required');
  assert.equal(state.lastSync, 30);
});

test('the runner retries a temporary open and upload, then discards the rejected draft', async () => {
  const state = { ...connection, job: restored() };
  let opens = 0;
  let uploads = 0;
  let deleted = 0;
  const worker = fixtures(state, (url, { method }) => {
    if (url.startsWith(rsi)) return documentFor();
    if (method === 'DELETE') {
      deleted += 1;
      return noContent();
    }
    if (url.includes('/pages/')) {
      uploads += 1;
      return uploads === 1
        ? new Response('', { status: 429 })
        : Response.json({ error: 'invalid_page' }, { status: 400 });
    }
    opens += 1;
    return opens === 1 ? new Response('', { status: 503 }) : opened();
  });
  await waitUntil(() => state.job.retryAt);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(uploads, 1);
  worker.advance(121000);
  await worker.alarm('resumeHangarImport');
  assert.equal(state.lastResult.error, 'invalid_page');
  assert.equal(uploads, 2);
  assert.equal(deleted, 1);
});

test('the runner records incomplete collection without asking for a page beyond its limit', async () => {
  for (const next of [1, 2, 250]) {
    const state = { ...connection, job: restored({ next, total: next, retries: 3 }) };
    const expected = next === 1 ? 'rsi_fetch_failed' : 'incomplete_pages';
    fixtures(state, (url, { body }) => {
      if (url.startsWith(rsi))
        return next < 250
          ? new Response('', { status: 503 })
          : documentFor({ page: 250, total: 251 });
      if (url.includes('/pages/')) {
        assert.equal(JSON.parse(body).total, 251);
        return Response.json({ ok: true });
      }
      if (url.endsWith('/complete')) {
        assert.equal(JSON.parse(body).issue, expected);
        return Response.json({ ok: false, error: expected });
      }
      return opened(next, next);
    });
    await waitUntil(() => state.lastResult);
    assert.equal(state.lastResult.error, expected);
  }
});

test('re-pair revokes the old device before redemption and handles an interrupted rotation', async () => {
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const state = {
    ...connection,
    pendingCredential: 'old-rotation',
    pendingPair: {
      id: 'new-proposal',
      code: '123456',
      origin: dashboard,
      accountName: 'New account',
      accountId: 'new-id',
      expiresAt,
    },
  };
  const steps = [];
  let revokeFails = true;
  let redeemFails = true;
  const worker = fixtures(state, (url, { method, body, headers }) => {
    steps.push(method);
    if (method === 'DELETE') {
      assert.equal(headers.Authorization, 'Bearer paired-token');
      assert.deepEqual(JSON.parse(body), { replacement: 'old-rotation' });
      return revokeFails ? new Response('', { status: 503 }) : new Response('', { status: 401 });
    }
    assert.match(url, /\/pair$/);
    assert.equal(state.eat, undefined);
    if (redeemFails) return Response.json({}, { status: 400 });
    return Response.json({ eat: 'new-token', accountId: 'new-id', expiresAt });
  });
  const confirm = () => worker.message('confirm-pair', { id: 'new-proposal' });
  assert.equal((await confirm()).error, 'network_error');
  assert.equal(state.eat, 'paired-token');
  assert.deepEqual(steps, ['DELETE']);
  revokeFails = false;
  assert.equal((await confirm()).error, 'pair_failed');
  assert.equal(state.eat, undefined);
  assert.equal(state.pendingPair.id, 'new-proposal');
  redeemFails = false;
  assert.equal((await confirm()).ok, true);
  assert.equal(state.eat, 'new-token');
  assert.equal(state.pairedAccountName, 'New account');
  assert.equal(state.rsiAccount, undefined);
  assert.deepEqual(steps, ['DELETE', 'DELETE', 'POST', 'POST']);
});

test('popup status refreshes older credentials with bounded polling and confirms revoked accounts', async () => {
  const state = { ...connection, pairedAccountName: undefined, pendingCredential: 'replacement' };
  const expiresAt = '2030-01-01T00:00:00.000Z';
  let mode = 'active';
  let reads = 0;
  const worker = fixtures(state, (_url, { method, headers }) => {
    assert.equal(method, 'GET');
    reads += 1;
    if (mode === 'active') return Response.json({ accountName: 'Verified Pilot', expiresAt });
    if (mode === 'rotation' && headers.Authorization === 'Bearer replacement')
      return Response.json({ ok: true });
    return new Response('', { status: 401 });
  });
  const status = () => worker.message('getStatus');
  assert.equal((await status()).pairedAccountName, 'Verified Pilot');
  assert.equal(state.expiresAt, expiresAt);
  assert.equal((await status()).autoSync, false);
  assert.equal(reads, 1);
  mode = 'rotation';
  worker.advance(31000);
  assert.equal((await status()).paired, true);
  assert.equal(reads, 3);
  mode = 'revoked';
  worker.advance(31000);
  assert.equal((await status()).paired, false);
  assert.equal(reads, 5);
  assert.equal(state.rsiAccount, undefined);
});

test('pairing proposals are versioned across overlapping previews and duplicate requests', async () => {
  const state = { autoSync: false };
  let release;
  const account = { accountName: 'Current pilot', accountId: 'current', expiresAt: '2030-01-01' };
  const worker = fixtures(state, (_url, { body }) => {
    const code = JSON.parse(body).code;
    if (code === '111111')
      return new Promise((resolve) => {
        release = resolve;
      });
    return Response.json(account);
  });
  const request = (code) => worker.message('bridge-pair', { code }, tab);
  const waiting = request('111111');
  await waitUntil(() => release);
  assert.equal((await request('222222')).ok, true);
  const visible = state.pendingPair.id;
  release(Response.json({ ...account, accountName: 'Stale pilot' }));
  assert.equal((await waiting).error, 'confirmation_expired');
  assert.equal((await request('222222')).ok, true);
  assert.equal(state.pendingPair.id, visible);
  assert.equal((await worker.message('dismiss-pair', { id: 'old' })).error, 'confirmation_expired');
  worker.advance(Date.parse(account.expiresAt) - Date.now() + 1000);
  assert.equal((await worker.message('getStatus')).pendingPair, undefined);
  assert.equal(
    (await worker.message('confirm-pair', { id: visible })).error,
    'confirmation_expired',
  );
});

test('failed RSI approval keeps the candidate and does not overwrite stored approval', async () => {
  const state = { ...connection, pendingRsiAccount: { ...pilot, id: 'known' } };
  let mode = 'signed-out';
  const worker = fixtures(state, () =>
    mode === 'signed-out' ? documentFor({ signedIn: false }) : Promise.reject(new Error('offline')),
  );
  assert.equal(
    (await worker.message('dismiss-rsi-account', { id: 'old' })).error,
    'confirmation_expired',
  );
  assert.equal(
    (await worker.message('confirm-rsi-account', { id: 'known' })).error,
    'rsi_sign_in_required',
  );
  mode = 'offline';
  assert.equal(
    (await worker.message('confirm-rsi-account', { id: 'known' })).error,
    'rsi_fetch_failed',
  );
  assert.equal(state.pendingRsiAccount.id, 'known');
  assert.equal(state.rsiAccount.accountKey, pilot.accountKey);
});

test('new checkpoints wait through transient RSI failures and reuse the same proposed account', async () => {
  const state = { ...connection, rsiSalt: undefined, rsiAccount: undefined };
  let upstream = 0;
  const worker = fixtures(state, (url) => {
    assert.ok(url.startsWith(rsi));
    upstream += 1;
    return upstream === 1 ? new Response('', { status: 503 }) : documentFor();
  });
  await worker.message('manual-sync');
  await waitUntil(() => state.job?.retryAt);
  assert.match(state.rsiSalt, /^[a-f0-9]{64}$/);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(state.lastResult.error, 'rsi_account_confirmation_required');
  const first = state.pendingRsiAccount.id;
  await worker.message('manual-sync');
  await waitUntil(() => !state.job && upstream === 3);
  assert.equal(state.pendingRsiAccount.id, first);
});

test('the worker stops on invalid checkpoints, revoked upload credentials and unverifiable pages', async () => {
  const input = [
    { error: 'invalid_response', open: () => opened(999, 999) },
    {
      error: 'invalid_eat',
      open: () => opened(1, 1),
      page: () => new Response('', { status: 401 }),
    },
    {
      error: 'rsi_sign_in_required',
      open: () => opened(1, 1),
      rsiResponse: () => documentFor({ signedIn: false }),
    },
    {
      error: 'incomplete_pages',
      open: () => opened(2, 2),
      rsiResponse: () => new Response('<p>Unknown document</p>'),
    },
  ];
  for (const scenario of input) {
    const state = { ...connection, job: restored() };
    fixtures(state, (url, { body }) => {
      if (url.startsWith(rsi)) return scenario.rsiResponse?.() || documentFor();
      if (url.includes('/pages/')) return scenario.page();
      if (url.endsWith('/complete')) {
        assert.equal(JSON.parse(body).issue, scenario.error);
        return Response.json({ error: scenario.error }, { status: 422 });
      }
      return scenario.open();
    });
    await waitUntil(() => state.lastResult);
    assert.equal(state.lastResult.error, scenario.error);
  }
});

test('a server-sealed draft remains linked and its outcome is recovered after cancellation', async () => {
  const state = { ...connection, job: restored({ retryAt: Date.now() + 100000 }) };
  const steps = [];
  const worker = fixtures(state, (_url, { method }) => {
    steps.push(method);
    if (method === 'DELETE') return Response.json({ error: 'import_closed' }, { status: 409 });
    return Response.json({ ok: true, outcome: 'success', reference: 'restored' });
  });
  await waitUntil(() => worker.alarms.has('resumeHangarImport'));
  assert.equal((await worker.message('cancel-sync')).error, 'import_busy');
  assert.equal(state.job.phase, 'committing');
  assert.equal(state.job.retryAt, undefined);
  await worker.alarm('resumeHangarImport');
  assert.deepEqual(steps, ['DELETE', 'PUT']);
  assert.equal(state.lastResult.ok, true);
  assert.equal(state.eat, 'paired-token');
});

test('hourly sync is opt-in, rotates expiring credentials and keeps the connection origin pinned', async () => {
  const state = {
    ...connection,
    autoSync: undefined,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  let replacement;
  let fetched = 0;
  const worker = fixtures(
    state,
    (url, { method, body, headers }) => {
      if (url.startsWith(rsi)) {
        fetched += 1;
        return documentFor();
      }
      assert.ok(url.startsWith(dashboard));
      if (method === 'GET') return Response.json({ accountName: 'Hangar Pilot' });
      if (url.endsWith('/credential')) {
        replacement = JSON.parse(body).replacement;
        assert.match(replacement, /^[0-9a-f]{64}$/);
        return Response.json({ expiresAt: '2030-01-01' });
      }
      assert.equal(headers.Authorization, 'Bearer ' + replacement);
      if (url.endsWith('/complete')) return Response.json({ ok: true });
      if (url.includes('/pages/')) return Response.json({ ok: true });
      return Response.json({ ok: true, next: 1, total: 1, expiresAt: '2031-01-01' });
    },
    { profile: 'development' },
  );
  await worker.alarm('hourlySync');
  assert.equal(fetched, 0);
  assert.equal((await worker.message('getStatus')).autoSync, false);
  await worker.message('set-settings', { devMode: true, autoSync: true });
  assert.equal(state.connectionBase, dashboard);
  assert.ok(worker.alarms.has('hourlySync'));
  await worker.alarm('hourlySync');
  assert.equal(state.eat, replacement);
  assert.equal(state.expiresAt, '2031-01-01');
  assert.equal(fetched, 1);
  assert.equal(state.lastResult.ok, true);
});

test('a checkpoint with a different local account binding is deleted without collecting pages', async () => {
  const state = { ...connection, job: restored({ accountKey: keyOf('Previous Pilot') }) };
  fixtures(state, (url, { method }) => {
    assert.ok(url.startsWith(dashboard));
    assert.equal(method, 'DELETE');
    return noContent();
  });
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'account_changed');
  assert.equal(state.rsiAccount.label, '@Pilot');
});

test('a pending disconnect blocks new syncs and retains a failed device removal for retry', async () => {
  const state = { ...connection };
  let release;
  let disconnects = 0;
  const worker = fixtures(state, (_url, { method }) => {
    assert.equal(method, 'DELETE');
    disconnects += 1;
    if (disconnects === 1)
      return new Promise((resolve) => {
        release = resolve;
      });
    return noContent();
  });
  const waiting = worker.message('disconnect-current');
  await waitUntil(() => release);
  assert.equal((await worker.message('triggerSync')).error, 'import_busy');
  assert.equal((await worker.message('disconnect-current')).error, 'import_busy');
  release(new Response('', { status: 503 }));
  assert.equal((await waiting).error, 'network_error');
  assert.equal(state.eat, 'paired-token');
  assert.equal((await worker.message('disconnect-current')).ok, true);
  assert.equal(state.eat, undefined);
});
