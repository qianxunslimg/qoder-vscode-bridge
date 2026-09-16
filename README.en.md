# Qoder VS Code Bridge

Connect enterprise Qoder to VS Code's native Chat. Install the extension, choose a Qoder model in the model picker, and start chatting.

[中文](README.md) · [Releases](https://github.com/qianxunslimg/qoder-vscode-bridge/releases)

![Qoder model catalog](docs/images/model-catalog.png)

## Installation

Requires VS Code `1.106.0` or later and Node.js/npm.

1. Download a `.vsix` from [Releases](https://github.com/qianxunslimg/qoder-vscode-bridge/releases).
2. Run `Extensions: Install from VSIX...` in VS Code.
3. Run `Developer: Reload Window`.

To package from source:

```sh
npm install
npm run package
```

## First run

1. Run `Qoder: Set Personal Access Token`. The token is stored in VS Code SecretStorage.
2. Open Chat and choose a model under `Qoder`.
3. Run `Qoder: Refresh Model Catalog` when the model list is stale.
4. Run `Qoder: Open Control Center` to inspect model capabilities and runtime settings.

There is no need to type `@qoder`. Run `Qoder: Clear Personal Access Token` to remove the token.

## What it supports

- VS Code's native Chat and model picker.
- Account-backed model discovery with per-model context and reasoning settings.
- File, selection, pasted-text, and image references.
- VS Code host tools such as Bash, Read, and Edit, with results returned to the same session.
- Account usage, plan, and expiry information when returned by the service.

## Control Center

Runtime settings (turn limit, tool timeout, activity summaries, and so on) are user-level settings. Context and reasoning controls on model cards are stored by model ID, so switching projects or conversations does not reset them.

Approval for host tools is controlled by VS Code Chat; the extension does not expose a second permission dropdown. When the SDK fallback path runs without host tools, it keeps the internal `bypassPermissions` behavior.

## Settings

Search for `Qoder Bridge` in VS Code Settings or edit user settings directly.

| Setting | Default | Purpose |
| --- | --- | --- |
| `qoderBridge.modelOverrides` | `{}` | Per-model context and reasoning overrides. |
| `qoderBridge.maxTurns` | `30` | Maximum Agent-loop turns for one request. |
| `qoderBridge.includePartialMessages` | `true` | Stream text deltas when available. |
| `qoderBridge.showActivity` | `true` | Show tool, task, retry, and completion summaries. |
| `qoderBridge.nativeToolLoop` | `true` | Use VS Code's native tool loop. |
| `qoderBridge.nativeToolResultTimeoutMs` | `300000` | Maximum wait for a host-tool result, in milliseconds. Range `5000`-`1800000`. |
| `qoderBridge.debugLogging` | `true` | Log loop metadata without prompts, file contents, or tokens. |
| `qoderBridge.maxNativeTools` | `91` | Maximum host tools exposed to one request. |
| `qoderBridge.maxInlineReferenceChars` | `24000` | Maximum selected or pasted characters copied into the prompt. |

## Files and images

- Selected text and pasted text are sent as bounded context.
- Whole files are normally read on demand by VS Code's `read_file` tool.
- Images require a vision-capable model in the account catalog.
- The `qoder_read_file` fallback only reads UTF-8 files inside the current workspace.

## Troubleshooting

- **Empty model catalog:** configure the PAT, then run `Qoder: Refresh Model Catalog`.
- **Missing images or references:** use a vision-capable model; whole-file references depend on VS Code's `read_file` tool, and the fallback cannot read outside the workspace.
- **Long-running tools:** increase `qoderBridge.nativeToolResultTimeoutMs` and inspect the Qoder extension-host log with `qoderBridge.debugLogging` enabled.
- **`session expired`:** wait for or cancel the running host tool, then use Chat's retry action.

## Development

```sh
npm install
npm test
npm run package
```

Press `F5` to start an Extension Development Host. Real-account smoke tests read the PAT from the environment, for example:

```sh
QODER_PERSONAL_ACCESS_TOKEN='your PAT' npm run catalog:smoke
```

## License

MIT
