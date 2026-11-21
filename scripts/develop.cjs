const { spawnSync } = require('node:child_process');
const result = spawnSync('wxt', process.argv.slice(2), {
  env: { ...process.env, CH_BUILD_PROFILE: 'development' },
  shell: process.platform === 'win32',
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
