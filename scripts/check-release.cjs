const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const expectedHosts = ['https://citizenhangar.space/*', 'https://robertsspaceindustries.com/*'];

for (const directory of ['chrome-mv3', 'firefox-mv2']) {
  const root = '.output/' + directory + '/';
  const manifest = JSON.parse(readFileSync(root + 'manifest.json', 'utf8'));
  const permissions =
    manifest.host_permissions ||
    manifest.permissions.filter((value) => value.startsWith('https://'));
  assert.deepEqual([...permissions].sort(), [...expectedHosts].sort());
  assert.doesNotMatch(JSON.stringify(manifest), /localhost|127\.0\.0\.1|<all_urls>/);
  assert.equal(manifest.version, require('../package.json').version);
  assert.ok(readFileSync(root + (manifest.action || manifest.browser_action).default_popup).length);
  for (const [size, path] of Object.entries(manifest.icons)) {
    const icon = readFileSync(root + path);
    assert.equal(icon.readUInt32BE(16), Number(size));
    assert.equal(icon.readUInt32BE(20), Number(size));
  }
}
