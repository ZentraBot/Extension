const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');
const { name, version } = require('../package.json');
const { report } = require('./console.cjs');

const expectedHosts = ['https://citizenhangar.space/*', 'https://robertsspaceindustries.com/*'];
const browserPermissions = ['alarms', 'storage'];
const requiredIconSizes = ['16', '32', '48', '128'];
const archivePrefix = '.output/' + name + '-' + version;

/** Read exactly one named file from the archive that is submitted to the store. */
function readFile(archive, filename) {
  const matches = archive
    .getEntries()
    .filter((entry) => entry.entryName === filename && !entry.isDirectory);
  assert.equal(matches.length, 1, 'Expected one packaged file at ' + filename);
  const bytes = matches[0].getData();
  assert.ok(bytes.length, 'Empty packaged file at ' + filename);
  return bytes;
}

/** Check the production permissions and the actual packaged executable assets. */
function verifyBrowserArchive(browser) {
  const archive = new AdmZip(archivePrefix + '-' + browser + '.zip');
  const manifest = JSON.parse(readFile(archive, 'manifest.json'));
  const firefox = browser === 'firefox';
  assert.equal(manifest.version, version);
  assert.equal(manifest.manifest_version, firefox ? 2 : 3);
  assert.deepEqual(
    [...manifest.permissions].sort(),
    (firefox ? [...browserPermissions, ...expectedHosts] : [...browserPermissions]).sort(),
    browser + ' permissions',
  );
  assert.deepEqual(
    [...(manifest.host_permissions || [])].sort(),
    firefox ? [] : [...expectedHosts].sort(),
    browser + ' host permissions',
  );
  assert.deepEqual(manifest.optional_permissions || [], [], browser + ' optional permissions');
  assert.deepEqual(manifest.optional_host_permissions || [], [], browser + ' optional hosts');
  assert.equal(manifest.externally_connectable, undefined, browser + ' external messaging');

  assert.equal(manifest.content_scripts.length, 1);
  const [bridge] = manifest.content_scripts;
  assert.deepEqual(bridge.matches, [expectedHosts[0]]);
  assert.ok(!bridge.all_frames && !bridge.match_about_blank && !bridge.match_origin_as_fallback);
  assert.equal(bridge.js.length, 1);
  readFile(archive, bridge.js[0]);

  if (firefox) {
    const { gecko } = manifest.browser_specific_settings;
    assert.equal(gecko.id, 'citizenhangar@sctr.space');
    assert.equal(gecko.strict_min_version, '124.0');
    assert.deepEqual(gecko.data_collection_permissions, {
      required: ['authenticationInfo', 'websiteContent', 'websiteActivity'],
      optional: [],
    });
    assert.equal(manifest.background.scripts.length, 1);
    readFile(archive, manifest.background.scripts[0]);
    readFile(archive, manifest.browser_action.default_popup);
  } else {
    assert.equal(manifest.minimum_chrome_version, '116');
    readFile(archive, manifest.background.service_worker);
    readFile(archive, manifest.action.default_popup);
  }

  assert.deepEqual(Object.keys(manifest.icons), requiredIconSizes);
  for (const [size, filename] of Object.entries(manifest.icons)) {
    const icon = readFile(archive, filename);
    assert.equal(icon.readUInt32BE(16), Number(size));
    assert.equal(icon.readUInt32BE(20), Number(size));
  }
}

/** Confirm the accompanying Firefox source archive belongs to this exact release. */
function verifySourceArchive() {
  const archive = new AdmZip(archivePrefix + '-sources.zip');
  const sourcePackage = JSON.parse(readFile(archive, 'package.json'));
  assert.equal(sourcePackage.name, name);
  assert.equal(sourcePackage.version, version);
  for (const path of ['package-lock.json', 'wxt.config.ts', 'entrypoints/background.ts']) {
    readFile(archive, path);
  }
  assert.ok(
    archive
      .getEntries()
      .every(
        ({ entryName }) =>
          !entryName.split('/').some((segment) => /^\.env(?:\.|$)|^\.git$/i.test(segment)),
      ),
    'Firefox source archive contains local environment or Git files',
  );
}

verifyBrowserArchive('chrome');
verifyBrowserArchive('firefox');
verifySourceArchive();
report('info', 'Chrome and Firefox release archives passed validation.');
