# Contributing

Issues and pull requests are welcome. Keep changes small and tested.

## Routing

| Situation | Use |
| --- | --- |
| Bug, crash, wrong behaviour | [Bug report](https://github.com/farijarifriyanto-debug/switchboard/issues/new?template=bug_report.yml) with repro steps |
| New capability you need | [Feature request](https://github.com/farijarifriyanto-debug/switchboard/issues/new?template=feature_request.yml) — discuss before coding |
| New tool or integration | Prefer a **plugin**, not a core change. Start from [switchboard-plugin-examples](https://github.com/farijarifriyanto-debug/switchboard-plugin-examples) and open an issue to discuss. |
| Security vulnerability | Private report, see `SECURITY.md` — never a public issue |

Most features are not accepted into core; they should be third-party plugins instead. Refactor-only PRs are not accepted unless a maintainer asks for them as part of a concrete fix.

## Development

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
