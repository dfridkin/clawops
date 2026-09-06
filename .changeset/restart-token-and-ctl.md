---
"@clawops/cli": patch
---

Fix gateway restart, and remove calls to a binary that does not exist

**`gateway restart`, `gateway update` and `config set` broke a working deployment.**
Each rebuilt the `docker run` string by hand and passed no gateway command at all, so
the container fell back to the image's bare `CMD` — losing `--allow-unconfigured`,
the port pin and the auth token, and dying with `Gateway start blocked: existing
config is missing gateway.mode`. Verified against OpenClaw 2026.7.1: a deployment
healthy after `clawops up` reached 30 restarts after one `gateway restart`.

v1.7.2 made this worse rather than causing it. Moving the token into an env file
fixed first boot and left the restart paths reading it from a config field that is
now always empty.

All three paths now build their command in one place, so they cannot drift again.
The token env file is attached through a shell test, so a deployment created before
v1.7.2 — which has no env file — still starts.

**`openclaw-ctl` is not a binary in the OpenClaw image.** `command -v openclaw-ctl`
returns nothing; the binary is `/usr/local/bin/openclaw`. `clawops backup create`,
`backup restore` and both MCP `agents` tools invoked it, so none of them ever ran.

- `backup create` now calls `openclaw backup create --output <path>` and streams the
  archive out. There is no stdout mode, which is what the previous `--stdout` flag
  assumed.
- `backup restore` now fails with an explanation. OpenClaw 2026.7.1 ships `backup
  create` and `backup verify` only — restore arrived in 2.0. Hand-rolling an untar
  into a live state directory is how backups become corruption.
- MCP `agents list` / `agents restart` call the real binary.
