# Citizen Hangar Pledge Sync extension

`npm run compile` checks the TypeScript source. `npm run zip` and `npm run zip:firefox` build the release archives. The repository also includes a release check that verifies manifest permissions, popup entry points, and icon sizes.

## Code quality

- `npm run format` formats the authored source. `npm run format:check` verifies it.
- `npm test` runs tests for the popup, content bridge, resumable sync, WXT configuration, and release scripts.
- `npm run test:coverage` enforces 95% coverage across statements, branches, functions, and lines. Tests use source maps to report against the authored TypeScript. `npm run test:coverage:report` produces the same report without enforcing the threshold.
- CLI logs use severity colours in a terminal. Set `NO_COLOR` to opt out or `FORCE_COLOR=1` to enable colours in redirected output.
