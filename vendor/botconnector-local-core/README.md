# BotConnector AI

[![npm](https://img.shields.io/npm/v/botconnector-ai?label=botconnector-ai)](https://www.npmjs.com/package/botconnector-ai)
[![Node.js](https://img.shields.io/node/v/botconnector-ai)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Website](https://img.shields.io/badge/website-botconnector.id-06305A)](https://botconnector.id/)

BotConnector is an open-source local-first AI workspace and CLI for chatting with local models, optional cloud AI, and coding-tool integrations.

Project: [GitHub source repository](https://github.com/farijarifriyanto-debug/BotConnector) · [botconnector.id](https://botconnector.id/) · [issue tracker](https://github.com/farijarifriyanto-debug/BotConnector/issues)

BotConnector is a local-first AI workspace and command-line client. It discovers GGUF models, downloads the files you choose, manages a verified llama.cpp runtime, and lets you chat from the terminal, desktop app, browser workspace, or a localhost OpenAI-compatible API. Cloud models are an explicit optional preview route; local prompts are not silently sent to the cloud.

| Chat workspace | Deep Research | Image Studio |
|---|---|---|
| ![BotConnector chat workspace](docs/chat-workspace.webp) | ![BotConnector deep research](docs/research-workspace.webp) | ![BotConnector image studio](docs/studio.webp) |

This is the `0.5.0-beta1` public npm beta. The npm package contains the CLI and Web Agent Workspace. Model weights and the managed runtime are downloaded separately after installation.

## Install

### Windows

Requirements: Windows 10 22H2 or later (x64), Node.js 22.12 or later, and npm.

```powershell
npm install --global botconnector-ai@0.5.0-beta1
botconnector --version
botconnector --help
```

### Linux

Requirements: a supported x64 Linux distribution, Node.js 22.12 or later, and npm. CPU works everywhere; Vulkan or CUDA can be selected when the matching runtime is available.

```bash
npm install --global botconnector-ai@0.5.0-beta1
botconnector --version
botconnector --help
```

The executable is always `botconnector`; the published package name is `botconnector-ai`.

## First run

Run `botconnector` in a real terminal. The Native Agent TUI opens its first-run flow and offers a hardware-aware starter model. Choose the recommended model, choose another model, or select cloud preview. Downloads require an explicit confirmation. After a model is ready, BotConnector can start the local runtime and send a test prompt.

Useful non-interactive checks:

```text
botconnector doctor
botconnector models search --recommended
botconnector runtime status
botconnector launch --list
```

Existing user-data locations are preserved. On Windows, settings and sessions remain under `%APPDATA%\botconnector-ai-local-cloud`; the browser workspace uses `%LOCALAPPDATA%\BotConnector AI`. On Linux, the profile uses `$XDG_DATA_HOME/botconnector` or `~/.local/share/botconnector`. Downloaded models remain in `~/BotConnector AI/models` on both platforms.

## Choosing a model

The TUI model picker supports three modes:

- `Auto`: use the active BotConnector model/runtime policy and hardware recommendation.
- `Local`: use a downloaded GGUF model through the managed llama.cpp runtime. CPU is the compatibility fallback; Vulkan and CUDA are available when supported.
- `Cloud`: use an explicitly selected provider/model in the private preview path. Configure credentials in the Desktop Cloud page or use the documented environment variables; cloud routing never happens implicitly for a local selection.

The TUI command `/model` opens the picker at any time. CLI equivalents include:

```text
botconnector models search <query>
botconnector models info <user/model>
botconnector get <user/model>@Q4_K_M
botconnector runtime use auto|cpu|vulkan|cuda12|cuda13|rocm
botconnector chat "Hello from BotConnector"
```

## TUI slash commands

In `botconnector`, type `/` to open the command palette. The beta includes:

- `/model` — choose Auto, a local model, or an explicitly configured cloud model.
- `/skills` — discover project and global Agent-Skills-compatible skills.
- `/mcp` — inspect, test, enable, and remove permissioned stdio MCP servers.
- `/diff` — inspect current Git changes.
- `/review` — request a read-only review of current changes using the active model.
- `/launch` — inspect and launch supported integrations.

Conversation scrollback is retained in the current session. Use PageUp/PageDown or Ctrl+Home/Ctrl+End to move through it; the input composer remains available at the bottom.

## Local API and chat

The local runtime binds to `127.0.0.1:11435` by default. Start a model and chat from a shell:

```text
botconnector server start <model-ref>
botconnector chat "Explain this error" --stream
botconnector server status
botconnector server stop
```

The OpenAI-compatible base URL is `http://127.0.0.1:11435/v1`. Native management, Anthropic-compatible, Responses, and embeddings routes are available when the selected runtime supports them. API authentication is opt-in; do not expose the service beyond localhost without a separately authenticated boundary.

## Web Agent Workspace

```text
botconnector ui                 # start localhost server and open the browser
botconnector ui --no-browser   # start it without opening a browser
botconnector serve              # headless localhost server
botconnector attach http://127.0.0.1:32100
```

`ui` and `serve` share the BotConnector Core. The server is localhost-only by default and Ctrl+C stops it cleanly.

## Cloud AI

Cloud is an explicit, provider-controlled private preview. It is not a public paid plan and has no customer billing in this beta. Inspect the state with `botconnector cloud status`; provider credentials are never printed. The cloud sidecar, when needed, is local-only:

```text
botconnector cloud serve
botconnector cloud providers
botconnector cloud models
botconnector cloud key-status
```

Use the Desktop app to persist provider credentials with the platform secure store. Environment credentials are suitable for development or CI. Local model selection remains local.

## Coding-tool integrations

`botconnector launch --list` reports detected integrations and their honest status. Verified launch/configuration paths cover Claude Code, Codex CLI, OpenCode, and supported editors when installed. BotConnector does not silently install third-party tools. OpenCode configuration is backed up before BotConnector changes it and can be restored with:

```text
botconnector launch opencode --config
botconnector launch opencode --restore
```

Claude Code, OpenCode, and Codex can use the localhost API through their supported environment/configuration mechanisms. The `/launch` TUI command exposes the same registry.

## Uninstall

Remove the npm CLI without deleting models, sessions, or settings:

```text
npm uninstall --global botconnector-ai
```

Uninstalling the npm package intentionally leaves BotConnector user data in place so reinstalling does not lose models or sessions. Delete those directories manually only when you are certain the data is no longer needed.

## Troubleshooting

- `botconnector --version` fails: confirm Node.js is 22.12+ and that the global npm bin directory is on `PATH`.
- No model is available: run `botconnector models search --recommended`, then download a small quantization with `botconnector get <user/model>@Q4_K_M`.
- Runtime is unavailable: run `botconnector doctor`, then `botconnector runtime resolve --backend auto` and `botconnector runtime install --backend auto`.
- Chat says the runtime is not loaded: start it with `botconnector server start <model-ref>` or use the TUI Installed → Run flow.
- A GPU backend fails: select `cpu`, verify the runtime, and retry. CPU is the compatibility fallback.
- `ui` cannot start: run `botconnector serve --port 32100` and open the printed localhost URL manually; check for another process already using the port.
- An integration is unavailable: install it using its official instructions and rerun `botconnector launch --list`.
- Start with `botconnector doctor` for a machine-specific diagnostic summary. Do not paste API keys, tokens, or private paths into bug reports.

## Security and privacy

BotConnector defaults to localhost-only networking, uses `shell:false` for managed process launches, constrains model deletion to the configured model directory, and keeps credentials out of normal status output. Review the confirmation screen before applying file changes, MCP permissions, or integration configuration.

## License

MIT. See [LICENSE](LICENSE).
