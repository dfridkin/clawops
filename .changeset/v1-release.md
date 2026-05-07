---
"@clawops/cli": major
---

v1.0 release — full CLI and MCP server for deploying self-hosted OpenClaw across AWS, GCP, Azure, and local VMs.

- All CLI commands implemented: `up`, `down`, `destroy`, `plan`, `apply`, `status`, `ssh`, `logs`, `tunnel`, `config`, `agents`, `gateway`, `backup`, `stacks`, `doctor`, `mcp`
- `--dry-run` support across all mutating commands
- Full `doctor` surface: Node version, config, SSH key, provider credentials, Pulumi home
- MCP server with stdio and HTTP transports; all operations exposed as typed MCP tools with R19 elicitation for destructive actions
- Plan → review → apply discipline enforced for cloud provider deployments
- Embedded Pulumi Automation API — no `pulumi` binary required
- SSH transport via `ssh2` — no system `ssh` dependency
- npm provenance via trusted publishing
