const assert = require('node:assert/strict');
const { createContext, Script } = require('node:vm');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runEntry } = require('./compileEntry.cjs');

function runScript(filename, { process = {}, dependencies = {}, console = {}, globals = {} } = {}) {
  const absolute = path.resolve(filename);
  const requireFile = createRequire(absolute);
  const scope = createContext({
    ...globals,
    process,
    console,
    module: { exports: {} },
    require: (name) => dependencies[name] ?? requireFile(name),
  });
  new Script(readFileSync(absolute, 'utf8'), { filename: absolute }).runInContext(scope);
  return scope.module.exports;
}

test('production and development WXT manifests enable only the intended hosts', () => {
  const fixture = { env: {}, cwd: () => '/workspace/test' };
  const context = createContext({
    process: fixture,
    require: (name) => (name === 'wxt' ? { defineConfig: (config) => config } : require(name)),
  });
  const config = runEntry('wxt.config.ts', context);
  const chrome = config.manifest({ browser: 'chrome' });
  assert.equal(chrome.host_permissions.length, 2);
  assert.equal(chrome.minimum_chrome_version, '116');
  const firefox = config.manifest({ browser: 'firefox' });
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '124.0');
  assert.equal(config.vite().define['process.env.CH_BUILD_PROFILE'], '"production"');
  fixture.env.CH_BUILD_PROFILE = 'development';
  assert.ok(config.manifest({ browser: 'chrome' }).host_permissions.includes('http://localhost/*'));
  assert.equal(config.vite().define['process.env.CH_BUILD_PROFILE'], '"development"');
});

test('release validation checks both actual archives and rejects added privileges or stale files', () => {
  const name = 'citizen-hangar-pledge-sync';
  const version = '1.4.0';
  const hosts = ['https://citizenhangar.space/*', 'https://robertsspaceindustries.com/*'];
  const options = { modifyBrowser: () => {}, modifySources: () => {} };
  const opened = [];
  const entry = (entryName, bytes) => ({
    entryName,
    isDirectory: false,
    getData: () => Buffer.from(bytes),
  });
  class Archive {
    constructor(filename) {
      opened.push(filename);
      this.filename = filename;
    }

    getEntries() {
      if (this.filename.endsWith('-sources.zip')) {
        const files = [
          entry('package.json', JSON.stringify({ name, version })),
          entry('package-lock.json', '{}'),
          entry('wxt.config.ts', 'fixture'),
          entry('entrypoints/background.ts', 'fixture'),
        ];
        options.modifySources(files);
        return files;
      }
      const firefox = this.filename.endsWith('-firefox.zip');
      const manifest = {
        version,
        manifest_version: firefox ? 2 : 3,
        permissions: ['storage', 'alarms'],
        content_scripts: [{ matches: [hosts[0]], js: ['bridge.js'] }],
        icons: { 16: '16.png', 32: '32.png', 48: '48.png', 128: '128.png' },
      };
      if (firefox) {
        manifest.permissions.push(...hosts);
        manifest.optional_permissions = [];
        manifest.optional_host_permissions = [];
        manifest.browser_action = { default_popup: 'popup.html' };
        manifest.background = { scripts: ['background.js'] };
        manifest.browser_specific_settings = {
          gecko: {
            id: 'citizenhangar@sctr.space',
            strict_min_version: '124.0',
            data_collection_permissions: {
              required: ['authenticationInfo', 'websiteContent', 'websiteActivity'],
              optional: [],
            },
          },
        };
      } else {
        manifest.host_permissions = hosts.slice();
        manifest.action = { default_popup: 'popup.html' };
        manifest.background = { service_worker: 'background.js' };
        manifest.minimum_chrome_version = '116';
      }
      options.modifyBrowser(manifest, firefox);
      return [
        entry('manifest.json', JSON.stringify(manifest)),
        entry('bridge.js', 'fixture'),
        entry('background.js', 'fixture'),
        entry('popup.html', '<main>Popup</main>'),
        ...Object.entries(manifest.icons).map(([size, filename]) => {
          const icon = Buffer.alloc(24);
          icon.writeUInt32BE(Number(size), 16);
          icon.writeUInt32BE(Number(size), 20);
          return entry(filename, icon);
        }),
      ];
    }
  }
  const logs = [];
  const dependencies = {
    'adm-zip': Archive,
    '../package.json': { name, version },
    './console.cjs': { report: (...args) => logs.push(args) },
  };
  const check = () => runScript('scripts/check-release.cjs', { dependencies });
  check();
  assert.deepEqual(opened, [
    '.output/' + name + '-' + version + '-chrome.zip',
    '.output/' + name + '-' + version + '-firefox.zip',
    '.output/' + name + '-' + version + '-sources.zip',
  ]);
  assert.match(logs.at(-1)[1], /passed validation/);

  for (const [edit, reason] of [
    [
      (manifest, firefox) => firefox && manifest.permissions.push('http://unexpected.invalid/*'),
      /firefox permissions/,
    ],
    [(manifest) => manifest.permissions.push('cookies'), /chrome permissions/],
    [
      (manifest) => (manifest.optional_host_permissions = ['https://unexpected.invalid/*']),
      /optional hosts/,
    ],
    [(manifest) => (manifest.optional_permissions = ['tabs']), /optional permissions/],
    [
      (manifest) => (manifest.content_scripts[0].matches = ['https://unexpected.invalid/*']),
      /strictly deep-equal/,
    ],
    [(manifest) => (manifest.content_scripts[0].all_frames = true), /falsy value/],
    [(manifest) => (manifest.content_scripts[0].match_about_blank = true), /falsy value/],
    [(manifest) => (manifest.content_scripts[0].match_origin_as_fallback = true), /falsy value/],
    [(manifest) => (manifest.action.default_popup = 'missing.html'), /Expected one packaged file/],
    [(manifest) => (manifest.version = '1.3.5'), /1\.3\.5/],
  ]) {
    options.modifyBrowser = edit;
    assert.throws(check, reason);
  }
  options.modifyBrowser = () => {};
  options.modifySources = (files) => files.push(entry('local/.env.production', 'private-fixture'));
  assert.throws(check, /local environment or Git files/);
});

test('store submission gate requires normalized import support at the production origin', async () => {
  const cases = [
    [200, { importProtocol: 2, importFormats: [1, 2] }, undefined, /supports normalized/],
    [404, {}, 1, /capabilities endpoint/],
    [503, {}, 1, /capabilities endpoint/],
    [200, { importProtocol: 1, importFormats: [1] }, 1, /support v2/],
    [200, { importProtocol: 2, importFormats: [1] }, 1, /format 2/],
    [200, { importProtocol: 2 }, 1, /format 2/],
  ];
  const readiness = [503, { ok: false }, 1, /readiness endpoint/];
  for (const [status, body, exitCode, message] of [...cases, readiness]) {
    const process = {};
    const logs = [];
    const requests = [];
    runScript('scripts/check-dashboard-capabilities.cjs', {
      process,
      globals: {
        AbortSignal,
        fetch: async (url, options) => {
          requests.push({ url, options });
          if (url.endsWith('/health/ready') && message !== readiness[3]) {
            return { status: 200, json: async () => ({ ok: true }) };
          }
          return { status, json: async () => body };
        },
      },
      dependencies: { './console.cjs': { report: (...args) => logs.push(args) } },
    });
    await new Promise((resolve) => setImmediate(resolve));
    const expected = ['/health/ready'];
    if (message !== readiness[3]) expected.push('/api/extension/capabilities');
    assert.deepEqual(
      requests.map(({ url }) => url),
      expected.map((target) => 'https://citizenhangar.space' + target),
    );
    assert.ok(
      requests.every(({ options }) => options.redirect === 'error' && options.cache === 'no-store'),
    );
    assert.equal(process.exitCode, exitCode);
    assert.match(logs.at(-1)[1], message);
  }
});

test('development and production helpers propagate child exit codes', () => {
  function commands(filename, results, extraProcess = {}) {
    const requested = [];
    const log = [];
    const options = {
      process: {
        env: {},
        platform: 'linux',
        argv: ['node', filename, '-b', 'firefox'],
        exit: (code) => {
          throw new Error('exit:' + code);
        },
        ...extraProcess,
      },
      dependencies: {
        child_process: {
          spawnSync: (...args) => {
            requested.push(args);
            return results.shift();
          },
        },
        'node:child_process': {
          spawnSync: (...args) => {
            requested.push(args);
            return results.shift();
          },
        },
        './console.cjs': { report: (...args) => log.push(args) },
      },
    };
    try {
      runScript(filename, options);
    } catch (error) {
      log.push(error.message);
    }
    return { requested, log, env: options.process.env };
  }
  for (const [status, expected] of [
    [0, 'exit:0'],
    [null, 'exit:1'],
  ]) {
    const run = commands('scripts/develop.cjs', [{ status }], {
      platform: status === 0 ? 'win32' : 'linux',
    });
    assert.ok(run.log.includes(expected));
    assert.equal(run.requested[0][2].env.CH_BUILD_PROFILE, 'development');
  }
  const successful = commands(
    'scripts/release-prepare-production.cjs',
    Array.from({ length: 3 }, () => ({ status: 0 })),
  );
  assert.equal(successful.requested.length, 3);
  assert.equal(successful.requested.at(-1)[0], 'node scripts/check-release.cjs');
  assert.equal(successful.env.CH_BUILD_PROFILE, 'production');
  assert.ok(
    commands('scripts/release-prepare-production.cjs', [
      { error: new Error('spawn') },
    ]).log.includes('exit:1'),
  );
  assert.ok(
    commands('scripts/release-prepare-production.cjs', [{ status: 2 }]).log.includes('exit:2'),
  );
  assert.ok(
    commands('scripts/release-prepare-production.cjs', [{ status: null }]).log.includes('exit:1'),
  );
});

test('logs use terminal colour preferences and keep readable severity labels', () => {
  const output = [];
  const console = {
    log: (...args) => output.push(args),
    error: (...args) => output.push(args),
    warn: (...args) => output.push(args),
  };
  for (const [env, tty, expected] of [
    [{ NO_COLOR: '', FORCE_COLOR: '1' }, true, false],
    [{ FORCE_COLOR: '0' }, true, false],
    [{ FORCE_COLOR: 'false' }, true, false],
    [{ FORCE_COLOR: '1' }, false, true],
    [{}, true, true],
  ]) {
    const logger = runScript('scripts/console.cjs', {
      process: { stdout: { isTTY: tty }, stderr: { isTTY: tty }, env },
      console,
    });
    logger.report('info', 'starting');
    assert.equal(output.at(-1)[0].includes('\u001b'), expected);
    logger.report('error', 'stopped');
    assert.match(output.at(-1)[0], /ERROR/);
  }
  const context = createContext({ console });
  runEntry('utils/console.ts', context);
  context.exports.browserWarning('offline', null);
  assert.match(output.at(-1)[0], /Citizen Hangar/);
});

test('counter reflects clicks using the updated state', () => {
  const context = createContext({});
  runEntry('components/counter.ts', context);
  let click;
  const node = {
    innerHTML: '',
    addEventListener(_name, callback) {
      click = callback;
    },
  };
  context.exports.setupCounter(node);
  assert.equal(node.innerHTML, 'count is 0');
  click();
  assert.equal(node.innerHTML, 'count is 1');
});
