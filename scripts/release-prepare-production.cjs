#!/usr/bin/env node
const { report } = require('./console.cjs');
// Build release archives without development hosts.
const { spawnSync } = require('child_process');

process.env.CH_BUILD_PROFILE = 'production';

const commands = ['wxt zip', 'wxt zip -b firefox', 'node scripts/check-release.cjs'];

for (const cmd of commands) {
  report('info', '\n> running:', cmd);
  const res = spawnSync(cmd, { shell: true, stdio: 'inherit' });
  if (res.error) {
    report('error', 'Command failed:', cmd, res.error);
    process.exit(1);
  }
  if (res.status !== 0) {
    report('error', 'Command exited with non-zero status', res.status);
    process.exit(res.status || 1);
  }
}

report('info', '\nAll commands completed successfully.');
