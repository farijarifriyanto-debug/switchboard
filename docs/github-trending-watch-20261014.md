# GitHub OSS watch — 14 October 2026

**Scope:** research and weekly repository watch for BotConnector/Switchboard. **Execution environments:** GitHub Actions after approved merge, and owner's Windows laptop for manual benchmarking. No VPS, backend changes, production deployment, or Chrome Web Store release.

## Snapshot: high-interest repositories

Checked against the GitHub repository API on 14 October 2026. Stars are **total cumulative**, not seven-day star growth.

| Repository | Total stars | Established functionality from upstream description | Potential use | Decision |
| --- | ---: | --- | --- | --- |
| [yetone/magpie](https://github.com/yetone/magpie) | 12,261 | Cross-agent model/provider switching, local gateway, routing groups / fallback | Compare with Switchboard provider interoperability | P0 study |
| [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast) | 22,867 | Indexed DOM/action choices; compact browser-agent decisions | Benchmark latency, stale state handling and browser tasks | P0 study |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 253,603 | Agent memory, skills, delegation, background tasks | Assess existing Switchboard capabilities before proposing changes | P1 study |
| [Niko1221/Strata](https://github.com/Niko1221/Strata) | 24,095 | Consumer hardware local model inference and compatible API | Local AI device evaluation | P2 study |
| [storytold/pdfcraft](https://github.com/storytold/pdfcraft) | 13,141 | PDF editor/viewer with native and web targets | OlahDokumen capability reference only | Refer to separate product |
| [storytold/photocraft](https://github.com/storytold/photocraft) | 59,182 | Native photo editor and agent/MCP control | Image Studio capability reference only | Refer to separate product |
| [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) | 52,615 | Multi-model chat and autonomous agent UI | Desktop UX comparison | P2 study |

Do not treat star counts as evidence of performance, security, community validity, or license fit. Check upstream release, LICENSE and dependencies before any code reuse.

## Strict reference policy (from this repo's AGENTS.md)

- **Claude in Chrome remains the authoritative browser UX reference.** Magpie and jev-ultrafast are technical comparisons only and do not authorize a different browser permission model, new modal, or extra dashboard.
- If Switchboard already has a capability, test the existing implementation before proposing replacement. No invented site-consent gate; use native Chrome permissions.
- Do not copy upstream brand, code, or internals without license/security checks. No integration or deployment from this watch.
- Show for each browser case: reference behavior, Switchboard behavior, evidence, MATCH/ADAPTASI SETARA/DIFF/BELUM TERVERIFIKASI and action.

## Laptop-only benchmarks (not executed; laptop `home` offline at inspection time)

1. **P0 / routing:** In Windows, compare existing Switchboard vs Magpie using matched provider/model and prompts. Record first-token P50/P95, errors, fallback correctness, streaming/tool-call integrity, configuration friction and quota behavior. Never forward existing session tokens to untrusted projects.
2. **P0 / browser:** Compare a visible Chrome side-panel workflow with Claude in Chrome and benchmark jev-ultrafast separately on the *same benign task*. Include tab context, at least 5 safe actions, form interaction, stale DOM, permitted and denied actions, Stop, recovery, and verifiable final page state. Benchmark upstream README claims independently; its cited 7.1-second run covers a narrow scenario.
3. **P1 / agents:** Audit Hermes skills, scheduled tasks and memory against *existing* Switchboard features. Prefer feature reuse; don't install extra daemons just for a benchmark.
4. **P2 / local AI:** Strata is only a candidate if laptop memory/GPU/disk satisfy official prerequisites. Do not download large model weights or enable any cloud billing without explicit authorization.
5. **Report:** For each trial capture command/build SHA, OS/Chrome version, visible result, elapsed time, errors, screenshots without secrets, cost, and upstream license. Label untested cases **BELUM TERVERIFIKASI**, never PASS.

## Automated weekly GitHub watch

Files:
- `.github/workflows/github-trending-watch.yml` — GitHub-hosted weekly schedule: Monday 01:00 UTC / 08:00 WIB, plus manual dispatch.
- `scripts/github-trending-watch.mjs` — GitHub Search API queries; deduplicates repositories and records totals, weekly changes when the prior baseline exists.
- `test/github-trending-watch.test.mjs` — self-contained unit tests (no network, no credentials).

Run tests from an authorized laptop checkout:

```powershell
node --test test/github-trending-watch.test.mjs
```

Each scheduled execution creates/updates one issue named `[GitHub Trending] YYYY-MM-DD` in this GitHub repository. First run is the baseline and **cannot** calculate week-over-week growth; subsequent reports compare star counts against the previous weekly issue. The issue embeds machine-readable public star totals, not secrets or user data. This is a sampled OSS watch, not the GitHub Trending official ranking.

**Release condition:** workflow does not run on schedule from this feature branch. It will run on the default branch only after an approved merge. PR unit tests can run before merge, but laptop integration testing remains outstanding.

**No production release requested or performed.**
