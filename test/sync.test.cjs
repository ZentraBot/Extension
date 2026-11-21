const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createContext } = require('node:vm');
const { runEntry } = require('./compileEntry.cjs');
const { webcrypto } = require('node:crypto');

function fixtures(state, upstream, initialTime = Date.now(), buildProfile = 'production') {
  const alarms = new Map();
  let now = initialTime;
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
      process: { env: { CH_BUILD_PROFILE: buildProfile } },
      Date: TestDate,
      browser,
      console,
      URL,
      AbortSignal,
      AbortController,
      fetch: upstream,
      crypto: webcrypto,
      navigator: { userAgent: 'Fixture Browser' },
    }),
  );
  initialise();
  return {
    message: (type, extra = {}) =>
      new Promise((resolve) => handler({ type, ...extra }, {}, resolve)),
    alarm: (name) => onAlarm({ name }),
    advance: (milliseconds) => {
      now += milliseconds;
    },
  };
}

async function waitUntil(predicate) {
  for (let index = 0; index < 200; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Expected the background job to reach its next state');
}

test('restart continues from the server checkpoint and transient errors back off', async () => {
  const state = {
    eat: 'test-token',
    autoSync: false,
    job: { reference: 'import-id', next: 1, total: 1, retries: 0, started: Date.now() },
  };
  const visits = [];
  let transient = true;
  const worker = fixtures(state, async (input, { method, body }) => {
    const url = new URL(input);
    if (url.hostname === 'robertsspaceindustries.com') {
      visits.push(url.searchParams.get('page'));
      if (transient) return new Response('', { status: 503 });
      return new Response('<a href="/account/pledges?page=3">Page 3</a>');
    }
    if (url.pathname.endsWith('/complete')) {
      assert.equal(JSON.parse(body).pageCount, 3);
      return Response.json({ ok: true, outcome: 'success' });
    }
    if (url.pathname.includes('/pages/')) return Response.json({ ok: true });
    assert.equal(method, 'PUT');
    return Response.json({ ok: true, next: 3, total: 3 });
  });
  await waitUntil(() => state.job.retryAt);
  assert.deepEqual(visits, ['3']);
  assert.equal((await worker.message('getStatus')).nextSync, undefined);
  transient = false;
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  await waitUntil(() => state.lastResult?.ok);
  assert.deepEqual(visits, ['3', '3']);
  assert.equal(state.job, undefined);
  assert.ok(state.lastSync);
});

test('cancel aborts collection and deletes the server draft without losing the last success', async () => {
  const state = { eat: 'test-token', autoSync: false, lastSync: 100 };
  let collecting = false;
  let deleted = false;
  const worker = fixtures(state, async (input, { method, signal }) => {
    if (new URL(input).hostname === 'robertsspaceindustries.com') {
      collecting = true;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    }
    if (method === 'DELETE') {
      deleted = true;
      return new Response(null, { status: 204 });
    }
    return Response.json({ ok: true, next: 1, total: 1 });
  });
  assert.equal((await worker.message('triggerSync')).ok, true);
  await waitUntil(() => collecting);
  assert.equal((await worker.message('cancel-sync')).ok, true);
  assert.equal(state.job, undefined);
  assert.ok(deleted);
  assert.equal(state.lastSync, 100);
});

test('background validates pairing, stores the new credential, and manages settings and revocation', async () => {
  const state = { autoSync: false, __sctr_logs: ['discard me'] };
  const worker = fixtures(
    state,
    async (input, { method, body }) => {
      assert.equal(method, 'POST');
      assert.equal(input, 'http://127.0.0.1:3000/api/extension/pair');
      const { code } = JSON.parse(body);
      if (code === '111111')
        return Response.json({ error: 'code_expired_or_invalid' }, { status: 400 });
      return Response.json({ eat: 'pair-token', expiresAt: '2030-01-01' });
    },
    Date.now(),
    'development',
  );

  assert.equal((await worker.message('pair', { code: 'x' })).error, 'invalid_code');
  for (const origin of [
    'https://other.example/',
    'invalid',
    'https://name:password@citizenhangar.space',
  ]) {
    assert.equal(
      (await worker.message('pair', { code: '123456', baseUrl: origin })).error,
      'invalid_dashboard',
    );
  }
  assert.equal((await worker.message('triggerSync')).error, 'not_paired');
  assert.equal(
    (await worker.message('set-settings', { devMode: true, debugEnabled: true, autoSync: true }))
      .ok,
    true,
  );
  assert.match((await worker.message('get-status')).dashboardUrl, /localhost/);
  assert.ok((await worker.message('getStatus')).nextSync);
  for (const [code, ok] of [
    ['111111', false],
    ['123456', true],
  ]) {
    assert.equal(
      (await worker.message('pair', { payload: { code }, baseUrl: 'http://127.0.0.1:3000' })).ok,
      ok,
    );
  }
  assert.equal((await worker.message('getStatus')).paired, true);
  assert.equal(state.eat, 'pair-token');
  assert.equal(state.__sctr_logs, undefined);
  assert.equal(state.diagnostics[0].msg, 'Browser paired.');
  assert.equal((await worker.message('clear-logs')).ok, true);
  assert.equal(state.diagnostics, undefined);
  assert.equal((await worker.message('revoke')).ok, true);
  assert.equal(state.eat, undefined);
  assert.equal((await worker.message('unknown')).error, 'unknown_action');
});

test('background persists a stable credential replacement before proceeding', async () => {
  const state = {
    eat: 'old',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    autoSync: false,
  };
  let replacement;
  const worker = fixtures(state, async (input, { headers, body }) => {
    if (input.endsWith('/credential')) {
      replacement = JSON.parse(body).replacement;
      assert.equal(state.pendingCredential, replacement);
      assert.equal(headers.Authorization, 'Bearer old');
      return Response.json({ ok: true, expiresAt: '2030-01-01' });
    }
    assert.equal(headers.Authorization, 'Bearer ' + replacement);
    return Response.json({ ok: true, outcome: 'success', reference: 'previous-commit' });
  });
  await worker.message('manual-sync');
  await waitUntil(() => state.lastResult?.ok);
  assert.match(replacement, /^[0-9a-f]{64}$/);
  assert.equal(state.eat, replacement);
  assert.equal(state.pendingCredential, null);
});

test('background expires old jobs and drops a revoked credential', async () => {
  const now = Date.now();
  const stale = {
    eat: 'old',
    job: { reference: 'job', next: 1, total: 1, retries: 0, started: now - 3600001 },
  };
  fixtures(
    stale,
    () => {
      throw new Error('Expired import must not make a request');
    },
    now,
  );
  await waitUntil(() => stale.lastResult);
  assert.equal(stale.lastResult.error, 'import_expired');

  const revoked = { eat: 'invalid', autoSync: true, lastSync: 123 };
  const worker = fixtures(revoked, () => new Response('', { status: 401 }));
  await worker.alarm('hourlySync');
  assert.equal(revoked.eat, undefined);
  assert.equal(revoked.lastSync, undefined);
  assert.equal(revoked.lastResult.error, 'invalid_eat');
});

test('background completes an RSI sign-in failure without replacing last success', async () => {
  const state = { eat: 'test', autoSync: false, lastSync: 30 };
  const worker = fixtures(state, (input, { body }) => {
    if (new URL(input).hostname === 'robertsspaceindustries.com')
      return new Response('', { status: 403 });
    if (input.endsWith('/complete')) {
      assert.equal(JSON.parse(body).issue, 'rsi_sign_in_required');
      return Response.json(
        { ok: false, outcome: 'failed', error: 'rsi_sign_in_required' },
        { status: 422 },
      );
    }
    return Response.json({ ok: true, expiresAt: '2030-01-01' });
  });
  await worker.message('initial-sync');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'rsi_sign_in_required');
  assert.equal(state.lastSync, 30);
});

test('background rejects cancellation during a commit and stops retrying after repeated failure', async () => {
  const state = {
    eat: 'test',
    job: {
      phase: 'committing',
      reference: 'job',
      next: 1,
      total: 1,
      retries: 3,
      started: Date.now(),
    },
  };
  let release;
  const worker = fixtures(state, (input) => {
    if (input.endsWith('/complete'))
      return new Promise((resolve) => {
        release = resolve;
      });
    return Response.json({ ok: true });
  });
  await waitUntil(() => release);
  assert.equal((await worker.message('cancel-sync')).ok, false);
  assert.equal((await worker.message('pair', { code: '123456' })).error, 'import_busy');
  release(new Response('', { status: 429 }));
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'network_error');
});

test('background skips its alarms when no import is due and waits for a scheduled retry', async () => {
  const now = Date.now();
  const state = {
    eat: 'test',
    autoSync: false,
    job: {
      reference: 'deferred',
      next: 1,
      total: 1,
      retries: 1,
      started: now,
      retryAt: now + 70000,
    },
  };
  let calls = 0;
  const worker = fixtures(
    state,
    () => {
      calls += 1;
      return Response.json({ ok: true });
    },
    now,
  );
  await worker.alarm('unrelated');
  await worker.alarm('hourlySync');
  await worker.alarm('resumeHangarImport');
  assert.equal(calls, 0);
  await worker.message('set-settings', { devMode: true });
  assert.equal(state.connectionBase, 'https://citizenhangar.space');
  await worker.message('revoke');
  await worker.alarm('resumeHangarImport');
  assert.equal(calls, 0);
  await worker.message('set-settings', { autoSync: true });
  await worker.alarm('hourlySync');
  assert.equal(calls, 0);
});

test('background resumes a persisted credential rotation and respects concurrent revocation', async () => {
  const state = { eat: 'original', pendingCredential: 'persisted', autoSync: false };
  let rotations = 0;
  const worker = fixtures(state, (url, { body }) => {
    assert.match(url, /credential$/);
    assert.equal(JSON.parse(body).replacement, 'persisted');
    rotations += 1;
    if (rotations === 1) throw Error('Network offline');
    state.eat = 'concurrent-replacement';
    return Response.json({ ok: true });
  });
  await worker.message('triggerSync');
  await waitUntil(() => state.job?.retryAt);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(rotations, 2);
  assert.equal(state.eat, 'concurrent-replacement');
});

test('background closes an exhausted collection and reports partial data', async () => {
  for (const next of [1, 2]) {
    const state = {
      eat: 'test',
      autoSync: false,
      job: { reference: 'exhausted', next, total: 2, retries: 3, started: Date.now() },
    };
    const expected = next === 1 ? 'rsi_fetch_failed' : 'incomplete_pages';
    fixtures(state, (url, { body }) => {
      if (url.includes('robertsspaceindustries')) return new Response('', { status: 500 });
      if (url.endsWith('/complete')) {
        assert.equal(JSON.parse(body).issue, expected);
        return Response.json({ ok: false, error: expected });
      }
      return Response.json({ ok: true, next, total: 2 });
    });
    await waitUntil(() => state.lastResult);
    assert.equal(state.lastResult.error, expected);
  }
});

test('background caps discovered pages and ignores malformed or unrelated links', async () => {
  const state = {
    eat: 'test',
    autoSync: false,
    job: { reference: 'capped', next: 250, total: 250, retries: 0, started: Date.now() },
  };
  fixtures(state, (input, { body }) => {
    if (input.includes('robertsspaceindustries'))
      return new Response(`
      <a href="https://[bad">Malformed link</a>
      <a href="https://other.example/account/pledges?page=1000">Different origin</a>
      <a href="/account/settings?page=1000">Not inventory</a>
      <a href="/account/pledges?page=1000&amp;product-type=ship">Filtered inventory</a>
      <a href="/account/pledges?page=no">Invalid page</a>
      <a href="/account/pledges?page=251">Real next page</a>`);
    if (input.endsWith('/pages/250')) {
      assert.equal(JSON.parse(body).total, 251);
      return Response.json({ ok: true });
    }
    if (input.endsWith('/complete')) {
      assert.equal(JSON.parse(body).issue, 'incomplete_pages');
      return Response.json({ ok: false, outcome: 'partial' });
    }
    return Response.json({ ok: true, next: 250, total: 250 });
  });
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.outcome, 'partial');
});

test('background handles an expired pairing request and a redirected RSI session', async () => {
  const state = { eat: 'test', autoSync: false };
  const worker = fixtures(state, (url, { body }) => {
    if (url.endsWith('/pair')) return Response.json({}, { status: 400 });
    if (url.includes('robertsspaceindustries')) {
      const response = new Response('');
      Object.defineProperties(response, {
        redirected: { value: true },
        url: { value: 'https://robertsspaceindustries.com/login' },
      });
      return response;
    }
    if (url.endsWith('/complete'))
      return Response.json({ ok: false, error: JSON.parse(body).issue });
    return Response.json({ ok: true });
  });
  assert.equal((await worker.message('pair', { code: '123456' })).error, 'pair_failed');
  await worker.message('triggerSync');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'rsi_sign_in_required');
});

test('background retries an interrupted draft upload and reports a terminal response', async () => {
  const state = { eat: 'test', autoSync: false, connectionBase: 'https://citizenhangar.space/' };
  let opened = 0;
  let uploads = 0;
  const worker = fixtures(state, (input) => {
    if (input.includes('robertsspaceindustries')) return new Response('<p>Page</p>');
    if (input.includes('/pages/')) {
      uploads += 1;
      return uploads === 1
        ? new Response('', { status: 429 })
        : Response.json({ error: 'invalid_page' }, { status: 400 });
    }
    opened += 1;
    return opened === 1 ? new Response('', { status: 503 }) : Response.json({ ok: true });
  });
  await worker.message('triggerSync');
  await waitUntil(() => state.job?.retryAt);
  worker.advance(61000);
  await worker.alarm('resumeHangarImport');
  assert.equal(uploads, 1);
  assert.ok(state.job.retryAt);
  worker.advance(121000);
  await worker.alarm('resumeHangarImport');
  await waitUntil(() => state.lastResult);
  assert.equal(state.lastResult.error, 'invalid_page');
  assert.equal(uploads, 2);
});
