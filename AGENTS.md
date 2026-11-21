# Extension agent instructions

Apply these instructions throughout the Citizen Hangar browser extension repository.

## Modularity

- Keep modules focused on one responsibility. Split unrelated handlers, data access, state transitions, and rendering into cohesive modules when adding or extending a feature.
- Keep entry points focused on wiring and lifecycle. Put feature logic in its own module and reuse existing helpers and contracts where they fit.
- Keep interfaces small and dependencies explicit. Share logic when callers have the same rules and lifecycle. Keep simple code inline when extracting it would only add indirection.
- When changing an existing large file, extract the responsibility you are extending if the change would otherwise make the file more monolithic. Preserve existing behavior and public interfaces.

## Performance

- Consider performance during implementation. Bound queries, lists, uploads, background work, and retries. Fetch only the records and fields needed for the current operation.
- Keep the initial render and navigation path small. Defer optional artwork, telemetry, and other work that can run after the page becomes usable. Prefer existing project assets and dependencies.
- Measure changes to frequently used paths with representative data, including large inventories where relevant. Check the relevant cost, such as query plans, transferred bytes, rendering time, or worker activity.
- Give each cache a clear scope, lifetime, and invalidation rule. Keep authenticated and private account data out of shared caches.

## Documentation and logs

- Use the repository formatter. Keep functions readable with descriptive names, blank lines between steps, and related operations grouped together.
- Write JSDoc for exported functions and modules with non-obvious contracts. Describe intent, inputs, results, errors, and side effects where they matter. Let TypeScript supply types it already declares.
- Add detailed comments for invariants, authorization boundaries, retries, compatibility paths, and resource limits. Explain why the code takes an approach and what would break if it changed. Keep comments current with the implementation.
- Use the repository logger for new operational messages. Use the established severity colours with human-readable level labels. Honour `NO_COLOR` and `FORCE_COLOR` for terminal output and keep redirected output readable.
- Redact pairing codes, access and refresh tokens, secrets, session identifiers, raw RSI pages, and private payloads from logs.

## Lunar Approach styling

- Treat the existing Lunar Approach screens as the design reference. Reuse their typography, spacing, colours, panels, buttons, forms, and status patterns.
- Use charcoal surfaces, warm peach accents, restrained borders, and a clear editorial hierarchy. Use Star Citizen artwork or imagery only where it serves the page, and preserve existing attribution.
- Avoid generic AI-dashboard patterns such as decorative gradients and glows, glass effects, filler badges, repetitive card grids, and promotional copy that repeats the interface. Use tables, compact controls, and plain labels where they help pilots navigate or act.
- Preserve keyboard navigation, visible focus, accessible control names, responsive layouts, and clear empty, loading, and error states. Review visual changes at desktop and narrow widths appropriate to the interface.

## Extension conventions

- Keep WXT entry points focused on browser lifecycle and message wiring. Put reusable sync, storage, API, and presentation logic in focused modules. Keep popup rendering, content bridge authorization, and background sync responsibilities separate.
- Preserve the durable sync checkpoint, bounded retries, and cancellation behavior. Keep Chrome and Firefox compatibility in shared modules and retain production host-permission boundaries.
- Use `entrypoints/popup/style.css` as the Lunar Approach reference for the popup. Maintain its compact hierarchy and give pairing, sync progress, and recovery actions the most prominent positions.
- Reuse `scripts/console.cjs` for CLI logs and `utils/console.ts` for browser warnings. Keep stored diagnostics optional and free of credentials and private payloads.
- Run `npm run format:check`, `npm run compile`, and `npm run test:coverage`. For release or permissions changes, also check both browser builds with `node scripts/check-release.cjs` after packaging.
