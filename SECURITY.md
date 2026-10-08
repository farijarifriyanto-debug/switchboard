# Security policy

Switchboard gives a language model a shell and your files, so security reports are welcome and taken seriously.

## Reporting

Please do **not** open a public issue for a vulnerability. Use GitHub's
[private vulnerability reporting](https://github.com/farijarifriyanto-debug/switchboard/security/advisories/new) on this repository, or email
admin@botconnector.id. Include the version (`sbx version`), what you did and what happened. You will
get an answer within a few days; fixes ship as a patch release with a note in `CHANGELOG.md`.

## Supported versions

The latest minor release (0.2.x) gets security fixes.

## What is by design

- `run_command` runs as you unless the sandbox is on (`tools.shell.sandbox`). Approval (default
  `risky`) is a confirmation step, not a sandbox. The sandbox is process isolation on a shared kernel.
- Anyone who can reach the console API can act as you on that machine. It binds to loopback, fences
  every request, and requires an access token off loopback; keep it that way.
- Skills, `AGENTS.md` and web pages are text the model reads. A malicious one can try to steer the
  model (prompt injection); approvals, presets and the sandbox are what limit the damage.
- The Telegram channel serves only allow-listed private chats and only an allow-listed user's tap
  can approve a tool call.

Reports about any of these *not* holding are exactly what we want.
