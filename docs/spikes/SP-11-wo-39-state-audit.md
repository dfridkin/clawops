# SP-11 / WO-39 audit — persisting state

**Image:** `ghcr.io/openclaw/openclaw:2026.9.2` · **Date:** 2026-09-07 · **Cost:** $0 (local Docker)

Audit before implementation. Two results make WO-39 **smaller** than planned; one makes a
single step riskier, and it is the one I could not finish verifying on this machine.

## A. Code surface

**The config path has no single source of truth** — the same disease WO-38 just cured for
the run command. Three TypeScript definitions and two shell templates:

| Where | Value |
|---|---|
| `plan/remote-config.ts:11` | `OPENCLAW_CONFIG_LINUX = '/home/clawops/openclaw.json'` |
| `cli/commands/gateway.ts:11` | its own local copy of the same string |
| `cli/commands/config.ts:8` | its own local copy again |
| `cli/commands/monitor.ts:65` | inline, in a `cat` |
| `providers/startup.ts:95` | `OPENCLAW_CONFIG=/home/clawops/openclaw.json` |
| `providers/local/bootstrap.sh.tmpl:28,35` | Linux and macOS variants |

Readers/writers that must move together: `readRemoteConfig`, `atomicWriteConfig`,
`cli/commands/config.ts`, `mcp/tools/cli/config.ts` (four `cat` sites), `monitor.ts`.

`configPathForOS()` splits Linux from macOS (`~/.config/openclaw/config.json`), so the
macOS branch needs its own answer rather than inheriting the Linux one.

## B. Runtime facts, measured

| Question | Answer |
|---|---|
| Container user | `User=node`, uid/gid **1000**, `HOME=/home/node` |
| Root entrypoint that could fix permissions? | **No** — `tini -s --`, already unprivileged |
| Default config path | `/home/node/.openclaw/openclaw.json` |
| State | `state/openclaw.sqlite` + `-wal` + `-shm` |
| Also written there | `cache/`, `media/`, `tmp/`, `workspace/`, `plugin-skills/`, `config-journal-fingerprint.key`, `openclaw.json.bak` |
| Written outside it | `~/.cache/openclaw`, `~/.local/share/pnpm`, `~/.config/openclaw` |

### One mount is enough

The plan called for the state dir, an auth-profile secret dir and a persistent `/home/node`.
Measured, **a single bind mount of `/home/node/.openclaw` covers config, SQLite state and
installed plugins**:

```
state survives container replacement:  fingerprint identical before/after
plugin installed at provisioning:      loads with --network none, restarts=0, refetched 0
```

That last line is SP-10b's fix working end to end: pre-install at provisioning, and a
locked-down host never reaches for ClawHub.

### `OPENCLAW_CONFIG_PATH` becomes unnecessary

With the directory mounted at the standard location, `openclaw config file` already resolves
to `/home/node/.openclaw/openclaw.json`. The env var can go — one less thing to keep in sync.

## C. G25 (ownership) — verified end to end

1. **Ubuntu 24.04 gives `clawops` uid 1001.** The `ubuntu` user already holds 1000, so
   `useradd -m clawops` — what `providers/startup.ts` runs — gets **1001**. Measured.
2. **The container writes as uid 1000**, with no root entrypoint to fix permissions. Measured.
3. **uid 1000 cannot write a 1001-owned, mode-700 directory.** Measured:
   `touch: /d/probe: Permission denied`.

So `chown clawops:clawops` on the host state dir hands it to 1001 and the gateway cannot
write its own database. Ownership must be numeric — `chown 1000:1000`.

4. **Verified end to end on real Linux**, via Docker-in-Docker (`docker:dind`, kernel
   6.12, Docker 29.8) so the mount is a native Linux bind mount rather than a Docker Desktop
   translation.

   A bind mount passes ownership through unchanged — `seen in container: 1001:1001` — and:

   | State dir owner | Gateway result |
   |---|---|
   | **1001** (what `chown clawops:clawops` produces) | `exited exit=1`, `EACCES: permission denied, stat '/home/node/.openclaw/state/openclaw.sqlite-wal'`, nothing written |
   | **1000** (numeric) | `running exit=0`, full state tree written |

   Run with WO-38's hardening applied (`--cap-drop=ALL`, `no-new-privileges`, `--init`,
   `--pids-limit 512`), so the controls do not interfere.

**The failure mode matters as much as the failure.** It is a hard, immediate exit with a
legible error, not silent corruption — so a health gate catches it and the message names
the cause. But under `--restart unless-stopped` it becomes a permanent crash-loop that
looks exactly like G30. Provisioning must get the chown right the first time; there is no
degraded mode to fall back to.

**A false negative worth recording.** My first attempt appeared to *disprove* this: a named
volume chowned to 1001 came back as 1000 and worked fine. That is Docker re-initializing an
**empty named volume** from the image path — a behaviour bind mounts do not have. The test
was invalid, not the hypothesis. A green result from the wrong mount type is exactly how
this would otherwise get waved through.

**Still worth doing at WO-39 completion:** a real Ubuntu 24.04 VM. Tiers above verify the
*mechanism*; only a cloud host exercises the provisioning script itself — `useradd` ordering,
a chown that runs before its mkdir, a missing `-R`.

## D. Migration is the real work

Existing deployments have a config **file** at `/home/clawops/openclaw.json`, owned by
`clawops`, and no state directory. WO-39 makes the config a **directory** at a new path.
An in-place upgrade that skips migration loses the deployment's configuration.

Provisioning must, idempotently:

1. create `/var/lib/clawops/openclaw`
2. `chown 1000:1000` — numerically, per §C
3. move an existing `/home/clawops/openclaw.json` into it, if present and the target is absent
4. leave a marker so a re-run does not undo a later edit

Any host still on the old layout after this is a deployment with no config, so the copy is
not optional.

## E. Net effect on scope

**Smaller than planned:** one mount instead of three; `OPENCLAW_CONFIG_PATH` deleted rather
than re-pointed.

**Larger than planned:** consolidating the config path to one definition (five sites today),
and the migration step, which the work order did not mention.

**Riskiest step:** the migration. The numeric chown is now fully verified, and its failure is
loud. Moving an existing config *file* into a new directory is the step with no verification
harness and a deployment's configuration riding on it.
