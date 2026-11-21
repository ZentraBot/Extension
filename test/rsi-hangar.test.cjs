const assert = require('node:assert/strict');
const { test } = require('node:test');
const { webcrypto } = require('node:crypto');
const { createContext } = require('node:vm');
const { runEntry } = require('./compileEntry.cjs');

const salt = 'browser-local-test-salt';
const url = new URL('https://robertsspaceindustries.com/account/pledges');
const pilot = { isSignedIn: true, handle: 'TestPilot', email: 'local-fixture@example.test' };
const escapedJson = (value) => JSON.stringify(value).replaceAll('"', '&quot;');

function fixture(fetch = async () => assert.fail('parser test must not perform network requests')) {
  const context = createContext({
    require,
    fetch,
    AbortSignal,
    URL,
    TextDecoder,
    TextEncoder,
    crypto: webcrypto,
  });
  return runEntry('utils/rsiHangar.ts', context) ?? context.exports;
}

function document({ user = pilot, head = '', pager = '', records = '' } = {}) {
  const properties = escapedJson({ user, xsrfToken: 'fixture-must-not-leave-the-browser' });
  return `<html><head>${head}</head><body data-platform-client-props="${properties}">${pager}<ul class="list-items">${records}</ul></body></html>`;
}

function pledge(name = 'Aurora MR', id = '99', extra = '') {
  return `<li><input class="js-pledge-id" value="${id}"><div class="title-col"><h3>${name}</h3></div>${extra}</li>`;
}

function response(body, status = 200, location = url.href) {
  const result = new Response(body, { status });
  Object.defineProperty(result, 'url', { value: location });
  return result;
}

test('RSI parser sends only allowlisted pledge fields and accepts relative, unfiltered pagination', async () => {
  const { parseRsiPage } = fixture();
  const html = document({
    head: '<link rel="canonical" href="?page=2">',
    pager: `<nav class="pager">
      <a class="active" href="?page=2">2</a><a href = "?page=5">5</a>
      <a href="?page=88&amp;product-type=ships">Filtered</a>
      <a href="https://other.example.test/account/pledges?page=90">Other origin</a>
      <a href="/account/status?page=91">Other path</a><a href="?page=-4">Invalid page</a>
      <a href="http://[invalid">Invalid link</a><a href="/account/pledges">First page</a>
    </nav>`,
    records: pledge(
      'Aurora MR',
      '99',
      `
      <input class="js-pledge-name" value="Aurora Bundle"><div class="items-col">Contains: Aurora</div>
      <div class="availability">Available</div><div class="date-col">Created: June 15, 2024</div>
      <input class="js-pledge-value" value="USD 26.00"><input class="js-pledge-configuration-value" value="28">
      <input class="js-pledge-currency" value="USD"><input name="email" value="private@example.test">
      <button class="js-gift">Gift</button><button class="js-reclaim">Reclaim</button>
      <div class="items more"><div class="with-images"><div class="item"><div class="text">
        <span class="title">Aurora MR</span><span class="kind">Ship</span><span class="liner">(RSI)</span>
      </div></div></div><div class="without-images"><div class="item">
        <span class="title">Game access</span><span class="title"> </span>
      </div></div></div><script>const privateField = 'not-a-pledge';</script>`,
    ),
  });
  const page = await parseRsiPage(html, new URL('/en/account/pledges?page=2', url), 2, salt);
  assert.equal(page.total, 5);
  assert.equal(page.empty, false);
  assert.equal(page.account.label, '@TestPilot');
  assert.match(page.account.accountKey, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(JSON.stringify(page.pledges)), [
    {
      pledgeId: '99',
      name: 'Aurora Bundle',
      contains: 'Aurora',
      availability: 'Available',
      dateText: 'June 15, 2024',
      rawValue: 'USD 26.00',
      rawConfigurationValue: '28',
      currency: 'USD',
      giftable: true,
      meltable: true,
      items: [{ title: 'Aurora MR', kind: 'Ship', manufacturer: 'RSI' }],
      alsoContains: ['Game access'],
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(page),
    /fixture-must-not-leave|private@example|local-fixture@example|not-a-pledge/,
  );
});

test('authenticated account identifiers are stable within one pairing and different across accounts and salts', async () => {
  const { parseRsiPage } = fixture();
  const parse = (user, fingerprintSalt = salt) =>
    parseRsiPage(document({ user, records: pledge() }), url, 1, fingerprintSalt);
  const original = await parse(pilot);
  assert.equal(
    (await parse({ ...pilot, handle: 'TESTPILOT' })).account.accountKey,
    original.account.accountKey,
  );
  assert.notEqual(
    (await parse({ ...pilot, handle: 'SecondPilot' })).account.accountKey,
    original.account.accountKey,
  );
  assert.notEqual(
    (await parse(pilot, 'separate-pairing')).account.accountKey,
    original.account.accountKey,
  );

  const identified = await parse({ ...pilot, accountId: 'account-161718' });
  assert.equal(
    (await parse({ ...pilot, handle: 'RenamedPilot', accountId: 'account-161718' })).account
      .accountKey,
    identified.account.accountKey,
  );
  const byId = await parse({ isSignedIn: true, accountId: 'account-161718' });
  assert.equal(byId.account.accountKey, identified.account.accountKey);
  assert.equal(byId.account.label, 'RSI account …161718');
  const byEmail = await parse({ isSignedIn: true, email: 'fixture@example.test' });
  const idWithEmail = await parse({
    isSignedIn: true,
    accountId: 'account-161718',
    email: 'fixture@example.test',
  });
  assert.equal(idWithEmail.account.accountKey, identified.account.accountKey);
  assert.equal(byEmail.account.label, 'fi…@example.test');
  assert.doesNotMatch(JSON.stringify(byEmail), /fixture@example\.test/);
});

test('invalid sessions, unreadable rows, unverified pagination and ambiguous empty states are rejected', async () => {
  const { parseRsiPage } = fixture();
  const parse = (html, page = 1) => parseRsiPage(html, url, page, salt);
  for (const html of [
    '<main>Sign in</main>',
    '<main data-platform-client-props="invalid JSON"></main>',
    document({ user: null, records: pledge() }),
    document({ user: ['invalid metadata'], records: pledge() }),
    document({ user: { isSignedIn: true, handle: 'invalid handle' }, records: pledge() }),
  ])
    await assert.rejects(parse(html), /rsi_account_unverified/);
  await assert.rejects(parse(document({ user: { isSignedIn: false } })), /rsi_sign_in_required/);
  for (const [html, page] of [
    [document({ records: pledge(), head: '<link rel="canonical" href="?page=2">' }), 1],
    [document({ records: pledge(), pager: '<div class="pager"><a class="active">2</a></div>' }), 1],
    [document({ records: pledge() }), 2],
    [document({ records: '<li>Unrecognized row</li>' }), 1],
    [document({ records: pledge('', '12') }), 1],
    [document({ records: pledge() + '<li>Unreadable second row</li>' }), 1],
    [
      document({
        records: pledge(
          'Aurora',
          '3',
          '<div class="items more"><div class="with-images"><div class="item"></div></div></div>',
        ),
      }),
      1,
    ],
    [document({ records: '<li><h4 class="empty-list">Nothing loaded yet.</h4></li>' }), 1],
    [
      document({
        records: pledge() + '<li><h4 class="empty-list">Your hangar is empty.</h4></li>',
      }),
      1,
    ],
    [document().replace('<ul class="list-items"></ul>', '<section>Maintenance</section>'), 1],
  ])
    await assert.rejects(parse(html, page), /rsi_page_unverified/);
  const empty = await parse(
    document({ records: '<li><h4 class="empy-list">Your hangar is empty.</h4></li>' }),
  );
  assert.equal(empty.empty, true);
  assert.equal(empty.pledges.length, 0);
});

test('RSI page fetching verifies destination, status and body limits before parsing', async () => {
  let reply;
  let request;
  const { fetchRsiPage } = fixture(async (destination, options) => {
    request = { destination, options };
    return reply;
  });
  reply = new Response(document({ records: pledge() }));
  assert.equal((await fetchRsiPage(1, salt, new AbortController().signal)).pledges.length, 1);
  assert.equal(request.destination, `${url.href}?page=1`);
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.cache, 'no-store');
  for (const invalid of [
    response('Sign in', 401),
    response('Access denied', 403),
    response('Login', 200, 'https://robertsspaceindustries.com/connect'),
    response('Different origin', 200, 'https://fixture.example.test/account/pledges'),
  ]) {
    reply = invalid;
    await assert.rejects(fetchRsiPage(1, salt), /rsi_sign_in_required/);
  }
  reply = response('Temporarily unavailable', 503);
  await assert.rejects(fetchRsiPage(1, salt), /rsi_fetch_failed/);
  reply = response(null, 204);
  await assert.rejects(fetchRsiPage(1, salt), /rsi_fetch_failed/);
  reply = response('x'.repeat(1024 * 1024 + 1));
  await assert.rejects(fetchRsiPage(1, salt), /rsi_page_unverified/);
});
