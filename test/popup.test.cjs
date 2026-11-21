const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { runEntry } = require('./compileEntry.cjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));

/** Load the shipping popup markup with a deterministic runtime and timers. */
function popup(t, initial, respond = () => ({ ok: true }), permissions = []) {
  const dom = new JSDOM(readFileSync('entrypoints/popup/index.html', 'utf8'), {
    runScripts: 'outside-only',
  });
  t.after(() => dom.window.close());
  const status = {
    paired: false,
    syncing: false,
    autoSync: false,
    debugEnabled: false,
    devMode: false,
    dashboardUrl: 'https://citizenhangar.space',
    connectionBase: 'https://citizenhangar.space',
    diagnostics: [],
    ...initial,
  };
  const queue = [];
  const sent = [];
  dom.window.browser = {
    runtime: {
      getManifest: () => ({ permissions }),
      async sendMessage(message) {
        sent.push(message);
        return message.type === 'getStatus' ? status : respond(message, status);
      },
    },
  };
  dom.window.require = () => ({});
  dom.window.setTimeout = (callback) => queue.push(callback);
  runEntry('entrypoints/popup/main.ts', dom.getInternalVMContext());
  const get = (id) => dom.window.document.getElementById(id);
  return {
    get,
    status,
    sent,
    queue,
    event: (id, type) =>
      get(id).dispatchEvent(new dom.window.Event(type, { bubbles: true, cancelable: true })),
    tick: async () => {
      const callback = queue.shift();
      assert.ok(callback);
      await callback();
      await settle();
    },
  };
}

test('popup pairs, reports validation errors, and handles settings and diagnostics', async (t) => {
  let response;
  const view = popup(
    t,
    {},
    (message, status) => {
      if (message.type === 'exchangeCode') {
        if (response.ok) status.paired = true;
        return response;
      }
      if (message.type === 'set-settings') {
        Object.assign(status, message);
        return { ok: true };
      }
      assert.equal(message.type, 'clear-logs');
      status.diagnostics = [];
      return { ok: true };
    },
    ['http://localhost/*'],
  );
  await settle();
  assert.equal(view.get('pairing').hidden, false);
  assert.equal(view.get('dev').closest('label').hidden, false);
  for (const [error, phrase] of [
    ['network_error', /Could not reach/],
    ['extension_disabled', /temporarily unavailable/],
    ['invalid_dashboard', /Open the Dashboard/],
    ['invalid_code', /code is invalid/],
  ]) {
    response = { ok: false, error };
    view.get('code').value = '123456';
    view.event('pair-form', 'submit');
    await settle();
    assert.match(view.get('feedback').textContent, phrase);
  }

  response = { ok: true };
  view.event('pair-form', 'submit');
  await settle();
  assert.equal(view.get('code').value, '');
  assert.equal(view.get('connected').hidden, false);
  assert.match(view.get('feedback').textContent, /Browser paired/);
  for (const control of ['dev', 'debug', 'auto-sync']) {
    view.get(control).checked = true;
    view.event(control, 'change');
    await settle();
    assert.equal(view.get(control).checked, true);
  }
  view.status.diagnostics = [{ ts: 'now', level: 'info', msg: 'Test log' }];
  view.event('clear-logs', 'click');
  await settle();
  assert.match(view.get('feedback').textContent, /Diagnostics cleared/);
  assert.equal(view.get('logs').textContent, 'No diagnostic messages.');
});

test('popup displays retries, committing, successful import and cancellation feedback', async (t) => {
  let allowCancel = false;
  const view = popup(
    t,
    {
      paired: true,
      syncing: true,
      autoSync: true,
      nextSync: 500,
      progress: { current: 1, total: 3, retryAt: 600 },
    },
    (message, status) => {
      if (message.type === 'cancel-sync') {
        if (allowCancel) status.syncing = false;
        return { ok: allowCancel };
      }
      if (message.type === 'triggerSync') {
        status.lastResult = { ok: true, reference: 'ref' };
        return { ok: true };
      }
      return undefined;
    },
  );
  await settle();
  assert.match(view.get('feedback').textContent, /Will retry/);
  assert.equal(view.get('progress').value, 1);
  assert.match(view.get('progress-label').textContent, /1 of 3/);
  assert.notEqual(view.get('next-sync').textContent, 'Off');

  view.status.progress = { current: 3, total: 3, committing: true };
  await view.tick();
  assert.match(view.get('feedback').textContent, /Saving/);
  assert.equal(view.get('cancel-sync').hidden, true);
  view.event('cancel-sync', 'click');
  await settle();
  assert.ok(view.sent.some(({ type }) => type === 'cancel-sync'));

  view.status.progress = undefined;
  allowCancel = true;
  view.event('cancel-sync', 'click');
  await settle();
  assert.match(view.get('feedback').textContent, /Import cancelled/);
  await view.tick();

  view.event('sync', 'click');
  await settle();
  assert.equal(view.get('last-result').textContent, 'Complete');
  assert.equal(view.get('support-code').textContent, 'ref');
});

test('popup explains each actionable import failure', async (t) => {
  for (const [error, outcome, phrase] of [
    ['import_expired', 'failed', /expired/],
    ['superseded', 'failed', /newer import/],
    ['invalid_page', 'failed', /size limit/],
    ['import_too_large', 'failed', /size limit/],
    ['rsi_sign_in_required', 'failed', /Sign in to RSI/],
    ['partial_sync', 'partial', /previous inventory/],
    ['invalid_eat', 'failed', /paired again/],
    ['not_paired', 'failed', /paired again/],
    ['network_error', 'failed', /could not reach/i],
    ['unknown', 'failed', /could not finish/],
  ]) {
    const view = popup(t, {
      paired: true,
      lastResult: { ok: false, error, outcome },
      lastSync: 100,
    });
    await settle();
    assert.match(view.get('feedback').textContent, phrase);
    assert.equal(view.get('rsi-login').hidden, error !== 'rsi_sign_in_required');
  }
});

test('popup reports unavailable status and failed runtime actions', async (t) => {
  const unavailable = popup(t, { paired: undefined });
  await settle();
  assert.match(unavailable.get('feedback').textContent, /status is unavailable/);

  const view = popup(t, { paired: true }, () => ({ ok: false }));
  await settle();
  view.event('sync', 'click');
  await settle();
  assert.match(view.get('feedback').textContent, /could not complete/);
  view.event('clear-logs', 'click');
  await settle();
  assert.match(view.get('feedback').textContent, /could not complete/);
});

test('popup polling reports completion and can recover a rejected status read', async (t) => {
  const finishing = popup(t, { paired: true, syncing: true });
  await settle();
  finishing.status.lastResult = { ok: true };
  finishing.status.syncing = false;
  await finishing.tick();
  assert.match(finishing.get('feedback').textContent, /Import complete/);

  const interrupted = popup(t, { paired: true, syncing: true });
  await settle();
  interrupted.status.paired = undefined;
  await interrupted.tick();
  assert.match(interrupted.get('feedback').textContent, /status is unavailable/);
});

test('popup serializes a pending action and watches a new manual sync', async (t) => {
  let start;
  const view = popup(t, { paired: true }, (message, status) => {
    if (message.type === 'triggerSync') {
      return new Promise((resolve) => {
        start = () => {
          status.syncing = true;
          resolve({ ok: true });
        };
      });
    }
    return { ok: false };
  });
  await settle();
  view.event('sync', 'click');
  view.event('sync', 'click');
  assert.equal(view.sent.filter(({ type }) => type === 'triggerSync').length, 1);
  start();
  await settle();
  assert.ok(view.queue.length);
  view.status.syncing = false;
  await view.tick();
  view.event('debug', 'change');
  await settle();
  assert.match(view.get('feedback').textContent, /could not complete/);
});
