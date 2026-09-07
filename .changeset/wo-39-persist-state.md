---
"@clawops/cli": major
---

Persist OpenClaw state: mount a directory, own it numerically, migrate the old config

**Deployments no longer lose their sessions, transcripts and credentials on restart.**
OpenClaw 2.0 keeps those in SQLite under a state directory, and clawops mounted no state at
all — so every `gateway restart`, `gateway update` and `config set`, all of which replace
the container, destroyed everything.

One host directory (`/var/lib/clawops/openclaw`, or `~/.clawops/openclaw` on macOS) is now
bind-mounted at OpenClaw's own default location. It holds the config, the SQLite database
and any provider plugins installed at provisioning time.

**The config is mounted as a writable directory, not a read-only file.** OpenClaw writes
its config by atomic rename, which fails `EBUSY` over a bind-mounted file whether mounted
`:ro` or `rw` — that blocked `openclaw plugins install` outright.

**`OPENCLAW_CONFIG_PATH` is gone.** The mount point is already OpenClaw's default, so
setting it was one more thing to keep in sync.

**Ownership is numeric — `chown 1000:1000`, never `clawops:clawops`.** On Ubuntu 24.04 the
`ubuntu` user already holds uid 1000, so `useradd clawops` gets **1001**, while the
container runs as 1000. A 1001-owned state directory makes the gateway exit 1 with
`EACCES … stat '<state>/state/openclaw.sqlite-wal'` and crash-loop under
`--restart unless-stopped`.

**Existing deployments migrate automatically.** Provisioning moves an existing
`/home/clawops/openclaw.json` into the new directory and leaves a `.migrated` marker.
It only does so when the destination is absent, so re-running provisioning never clobbers
a later edit. Without this an in-place upgrade would come up with no configuration at all.

The config path also had five definitions across three TypeScript files and two shell
templates; it now has one, in `src/openclaw/runtime.ts`.
