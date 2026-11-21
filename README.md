# Citizen Hangar Pledge Sync extension

The extension supports Chromium 116 and Firefox 124 or later. These versions support combining request timeouts and user cancellation with `AbortSignal.any()`.

## Release

Use `npm run release:prepare:production` to build and verify the Chrome and Firefox archives and the corresponding Firefox source archive. The check validates the actual ZIPs, including allowed hosts, browser permissions, content-script matches, minimum browser versions, and required executable assets.

Deploy the Dashboard with import protocol 2 and format 2 support to every production replica before releasing this extension. Run `node scripts/check-dashboard-capabilities.cjs` to check the public readiness and capabilities endpoints. The Firefox release workflow runs that check immediately before submission and stops when the Dashboard is unavailable or lacks format 2. Re-run a blocked release after completing the Dashboard deployment. Publish only the versioned archives that passed validation.

## Code quality

- `npm run format` formats the authored source. `npm run format:check` verifies it.
- `npm test` runs tests for the popup, content bridge, resumable sync, WXT configuration, and release scripts.
- `npm run test:coverage` enforces 95% coverage across statements, branches, functions, and lines. Tests use source maps to report against the authored TypeScript. `npm run test:coverage:report` produces the same report without enforcing the threshold.
- CLI logs use severity colours in a terminal. Set `NO_COLOR` to opt out or `FORCE_COLOR=1` to enable colours in redirected output.
