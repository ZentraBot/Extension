const assert = require('node:assert/strict');
const { createContext, Script } = require('node:vm');
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { runEntry } = require('./compileEntry.cjs');

function runScript(filename, { process = {}, dependencies = {}, console = {} } = {}) {
  const absolute = path.resolve(filename);
  const requireFile = createRequire(absolute);
  const scope = createContext({
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
  assert.equal(config.manifest().host_permissions.length, 2);
  assert.equal(config.vite().define['process.env.CH_BUILD_PROFILE'], '"production"');
  fixture.env.CH_BUILD_PROFILE = 'development';
  assert.ok(config.manifest().host_permissions.includes('http://localhost/*'));
  assert.equal(config.vite().define['process.env.CH_BUILD_PROFILE'], '"development"');
});

test('release archive validation covers both manifest formats and rejects unapproved hosts', () => {
  const icon = Buffer.alloc(24);
  icon.writeUInt32BE(16, 16);
  icon.writeUInt32BE(16, 20);
  const permissions = ['https://citizenhangar.space/*', 'https://robertsspaceindustries.com/*'];
  let unsafe = false;
  const files = {
    readFileSync(filepath) {
      if (filepath.endsWith('manifest.json')) {
        const hosts = unsafe ? [...permissions, 'http://localhost/*'] : permissions;
        const shared = { version: '1.4.0', icons: { 16: 'icon.png' } };
        return JSON.stringify(
          filepath.includes('firefox')
            ? {
                ...shared,
                permissions: [...hosts, 'storage'],
                browser_action: { default_popup: 'popup.html' },
              }
            : { ...shared, host_permissions: hosts, action: { default_popup: 'popup.html' } },
        );
      }
      return filepath.endsWith('icon.png') ? icon : '<main>Popup</main>';
    },
  };
  const dependencies = { 'node:fs': files, '../package.json': { version: '1.4.0' } };
  runScript('scripts/check-release.cjs', { dependencies });
  unsafe = true;
  assert.throws(() => runScript('scripts/check-release.cjs', { dependencies }));
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
    Array.from({ length: 4 }, () => ({ status: 0 })),
  );
  assert.equal(successful.requested.length, 4);
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
