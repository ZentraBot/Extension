const assert = require('node:assert/strict');
const { report } = require('./console.cjs');

const production = 'https://citizenhangar.space';
const requiredFormat = 2;

/** Read a direct JSON response from the production origin within a fixed deadline. */
async function readJson(path, label) {
  const response = await fetch(production + path, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, label);
  return response.json();
}

/**
 * Check the public production API used by this build before submitting to a store.
 * The old API can pass readiness and pair but cannot accept a format 2 import.
 */
async function checkDashboardCapabilities() {
  const ready = await readJson('/health/ready', 'Production Dashboard readiness endpoint');
  assert.equal(ready.ok, true, 'Production Dashboard is not ready');
  const { importProtocol, importFormats } = await readJson(
    '/api/extension/capabilities',
    'Production Dashboard extension capabilities endpoint',
  );
  assert.equal(importProtocol, 2, 'Production Dashboard must support v2 imports');
  assert.ok(
    Array.isArray(importFormats) && importFormats.includes(requiredFormat),
    'Production Dashboard must support normalized import format 2',
  );
}

checkDashboardCapabilities()
  .then(() => report('info', 'Production Dashboard supports normalized extension imports.'))
  .catch((error) => {
    report('error', error.message);
    process.exitCode = 1;
  });
