# Contributing

Issues and pull requests are welcome. Keep changes small and tested.

```sh
npm ci
npm run typecheck && npm run build && npm test
```

- `npm test` runs every `scripts/test-*.mjs` against stub endpoints (no network, no API key).
  `test-sandbox.mjs` also checks real isolation when bubblewrap or docker are available and says so
  when it skips.
- CI runs on Node 20 and 22. `scripts/browser-smoke.mjs` (real Chromium) runs only on request.
- A behaviour change needs a test that fails without it and a line in `CHANGELOG.md`.
- Security-sensitive changes (approvals, sandbox, console fence, file confinement, `web_fetch`) must
  keep the fail-closed behaviour: when in doubt, refuse.
- Report vulnerabilities privately, see `SECURITY.md`.
