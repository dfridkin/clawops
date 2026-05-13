# @clawops/cli

## 1.2.0

### Minor Changes

- e16137f: Wave 8B: first-run setup wizard, config overlay, and macOS bootstrap (WO-02, WO-03, WO-16)

  ## New features

  - `clawops setup` — interactive wizard that guides first-time users through deploying OpenClaw and connecting it to an AI model, chat integrations, and local AI editors
    - Deployment type: cloud (AWS / GCP / Azure) or local/existing server over SSH
    - LLM provider selection (Anthropic, OpenAI, Bedrock, Ollama, and others from `spec/models.yaml`)
    - Chat integration selection via multi-select checkbox (Discord, Telegram, Slack, WhatsApp, Teams)
    - Secret collection: paste-and-save, environment variable ref, or file path
    - AI app MCP wiring via multi-select checkbox (Claude Desktop, Claude Code, Cursor, Windsurf) — uses absolute binary path so host apps can spawn it without inheriting the user's shell PATH
    - Generates a gateway auth token (`~/.clawops/secrets/GATEWAY_TOKEN_<stack>`) and applies it to the remote config; final output shows a tokenized dashboard URL
    - Local deploy path: bootstraps the host over SSH with streaming progress, applies the config overlay, and restarts the gateway with the auth token — process exits cleanly via `drainPool()`
    - Cloud deploy path: writes a `clawops-<stack>-plan.json` deploy plan and optionally calls `clawops apply`; `apply.ts` handles post-provisioning config overlay and gateway restart

  ## Bug fixes

  - Secrets passed through `resolveSecrets` on local deploy — API keys and integration tokens are resolved to real values before being written to the remote config instead of left as literal `$secret:` refs
  - Gateway token stored per-stack (`GATEWAY_TOKEN_<name>`) — multiple setup runs no longer clobber each other's tokens
  - SSH username defaults to current OS user (correct for localhost) instead of hardcoded `"ubuntu"`
  - Output-dir prompt skipped for local provider (always uses `"."`)
  - Duplicate `provider` field removed from models config overlay
  - Docker NOT_RUNNING on a non-localhost host now starts Docker on the remote server via SSH (`sudo systemctl start docker` with 90 s polling) instead of trying to start it on the user's machine
  - `gateway run` startup command updated to `--allow-unconfigured --token TOKEN` — the gateway requires `--allow-unconfigured` when model config has not passed its internal validation; omitting it caused a crash loop
  - Remote OS detection (`uname -s` over SSH) selects the correct OpenClaw config path (`~/.config/openclaw/config.json` on macOS vs `/home/clawops/openclaw.json` on Linux)
  - `sudo -S -p ''` suppresses the "Password:" prompt that was leaking into error messages
  - `execWithFallbackSudo` handles AWS Ubuntu hosts that SSH as a non-clawops user with passwordless sudo
  - macOS Docker PATH prefix injected in `restartGateway` SSH exec so `docker` is found in non-interactive sessions

## 1.1.0

### Minor Changes

- 9ea3b34: Add adoption documentation waves 1–3 and MCP registry metadata.

  **Wave 1 (R1, R2, R6, R8):** README rewrite with accurate plan/apply semantics and first-success quickstart (WO-01, WO-04); public roadmap and limitations pages (WO-22); provider capability matrix (WO-17).

  **Wave 2 (R1):** Local VM and VPS quickstart guide (WO-02); example OpenClaw model/channel configs (WO-03).

  **Wave 3 (R3):** MCP safety modes overview and tool risk matrix (WO-07); Claude Code and Cursor client integration guides with read-only/no-destructive setup (WO-08); audit log field reference and redaction guarantees (WO-09).

  **MCP registry:** Added `mcpName` field (`io.github.dfridkin/clawops`) to enable listing on the MCP Registry. The MCP server ships in `@clawops/cli` (invoked via `clawops mcp serve`) — no separate package.

## 1.0.0

### Major Changes

- 4119d20: v1.0 release — full CLI and MCP server for deploying self-hosted OpenClaw across AWS, GCP, Azure, and local VMs.

  - All CLI commands implemented: `up`, `down`, `destroy`, `plan`, `apply`, `status`, `ssh`, `logs`, `tunnel`, `config`, `agents`, `gateway`, `backup`, `stacks`, `doctor`, `mcp`
  - `--dry-run` support across all mutating commands
  - Full `doctor` surface: Node version, config, SSH key, provider credentials, Pulumi home
  - MCP server with stdio and HTTP transports; all operations exposed as typed MCP tools with R19 elicitation for destructive actions
  - Plan → review → apply discipline enforced for cloud provider deployments
  - Embedded Pulumi Automation API — no `pulumi` binary required
  - SSH transport via `ssh2` — no system `ssh` dependency
  - npm provenance via trusted publishing
