# @clawops/cli

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
