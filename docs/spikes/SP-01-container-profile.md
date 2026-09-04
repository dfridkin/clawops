# SP-01 — Container profile, state path, uid/gid, loopback impact

**Status:** COMPLETE — 2026-09-04
**Environment:** EC2 spot `t3.medium`, **x86_64**, Ubuntu 24.04.4 LTS, Docker 29.8.0,
OpenClaw `ghcr.io/openclaw/openclaw:2026.8.1` (amd64, 2.12 GB, `user=node` uid 1000).
A real Linux host, not Docker Desktop — required, because Q3 turns on uid mapping across the
host boundary.

---

## Q1 — Confirm or refute G1, G2, G3, G5 by observation

Reproduced the clawops v1.7.x path exactly: `-p 18789:18789`, config bind-mounted
`/home/clawops/openclaw.json → /app/config.json:ro`, no state volume, command
`node openclaw.mjs gateway run --allow-unconfigured`.

### G1 — REFUTED

The plan's headline defect does not exist. OpenClaw 2.0 logs:

> `Container environment detected — the gateway defaults to bind=auto (0.0.0.0) for port-forwarding compatibility.`

The documented `loopback` default **does not apply inside a container**. With a token supplied,
`/healthz` and `/startupz` both answer 200 through the published port. **`--bind lan` is
unnecessary** — the container-detection default already does the right thing.

### What actually happens instead — and it is loud, not silent

Without a token the gateway refuses to start:

```
Refusing to bind gateway to auto without auth.
Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_GATEWAY_PASSWORD, or pass --token/--password
container: restarting exit=78 restarts=5
```

With `--restart unless-stopped` that is an **infinite crash-loop on first deploy** — not on upgrade,
which is where the plan expected it. clawops's startup script writes `auth.mode: "token"` with no
token value and passes no `--token`, so this is the real first-boot failure.

Once `clawops config` writes a token, `remote-config.ts` passes `--token` on argv and the gateway
starts and is reachable. So current deployments *do* work — via the argv token (G6), on a path
upstream documents as dev-only (G5).

### G2 — CONFIRMED

State lives only inside the container:

```
/home/node/.openclaw → cache config-journal-fingerprint.key media plugin-skills
                       state tmp workspace worktrees   (2.1 MB)
state/openclaw.sqlite, -shm, -wal
host /home/clawops   → openclaw.json only
mounts               → /home/clawops/openclaw.json -> /app/config.json (rw=false)
```

Replacing the container the way `clawops gateway restart` does changes the install fingerprint
`fd514eea3e77f288 → 5f2329e25c5745db`: **new install identity, all prior state gone.**

### G3 — CONFIRMED, and worse than stated

```
OPENCLAW_CONFIG_PATH=<unset>
ls: cannot access '/home/node/.openclaw/openclaw.json': No such file or directory
```

The gateway's config file **does not exist**. It runs entirely on defaults. `/app/config.json` — the
path clawops mounts — is read by nothing. **Every setting clawops writes is silently discarded:**
models, channels, auth mode. The deployment only functions because the token arrives on argv.

This is a bigger correctness problem than "config migrations are blocked". `clawops config set`
appears to succeed and changes nothing.

### G5 — CONFIRMED

With `gateway.mode` absent and no `--allow-unconfigured`:

> `Gateway start blocked: existing config is missing gateway.mode. Treat this as suspicious or
> clobbered config.` → exit 78

---

## Q2 — State-path A/B: identity mapping is NOT required

| Variant | Container path | Result |
|---|---|---|
| **A** standard | `/home/node/.openclaw` | **running**, `/healthz` ok, state persisted to host |
| **B** identity-mapped | `/var/lib/clawops/openclaw` | **running**, `/healthz` ok, state persisted to host |

Both work unsandboxed. **WO-39 takes the standard path**, matching upstream and Fleet. Identity
mapping stays a sandboxing-only question for SP-04. The earlier draft's "adopt it unconditionally"
was over-decided, as the review found.

---

## Q3 — uid/gid: the real trap, confirmed

| Host dir owner | Container path | Result |
|---|---|---|
| uid **1000** | `/home/node/.openclaw` | running, healthy |
| uid **1001** | `/home/node/.openclaw` | **exit 1** — `EACCES: permission denied, stat '/home/node/.openclaw/state/openclaw.sqlite-wal'` |

**New gap — G25.** On a fresh Ubuntu cloud image `ubuntu` already holds uid 1000, so the `clawops`
user that clawops creates gets **uid 1001**. The container runs as `node` = uid 1000. clawops
currently chowns its config to `clawops:clawops` (`startup.ts`, `remote-config.ts`,
`bootstrap.sh.tmpl`). Apply that same ownership to the state directory and **the gateway cannot
write its own database and dies.**

This is the "late, confusing bug across four providers" the plan's risk section predicted, found
before it shipped. The state directory must be owned by **uid 1000**, not by the `clawops` OS user.
Ownership must be asserted numerically — the name `clawops` resolves to different uids on different
base images.

---

## Q4 — Loopback publishing: viable, and `clawops tunnel` covers it

With `-p 127.0.0.1:18789:18789` (the Fleet profile):

| From | Result |
|---|---|
| VM loopback | `{"ok":true,"status":"live"}` |
| VM private LAN address | unreachable |
| Public internet | unreachable (timeout) |
| **SSH tunnel** (`-L 18899:127.0.0.1:18789`) | `{"ok":true,"status":"live"}` |

Loopback publishing works and `clawops tunnel` reaches it unchanged. **The firewall need not open
18789 at all**, which strengthens N10 rather than compromising it.

The breaking-change caveat from the review stands: anyone reaching their gateway directly on
`:18789` today loses that path. It needs a migration-guide entry and a `spec.network.publish`
escape hatch for operators who knowingly want the old behavior.

---

## Assertions to graduate into the suite (§5)

1. Rendered `docker run` publishes to `127.0.0.1:<port>`, mounts a state volume, and sets no `:ro` on config. *(unit, no VM)*
2. State directory ownership is asserted as **uid 1000**, never by user name. *(unit, no VM)*
3. Gateway answers `/startupz` through the published port after apply. *(VM)*
4. Install fingerprint is unchanged across container replacement. *(VM)*
5. A config written by clawops is the config the gateway reads back. *(VM — G3 regression)*
