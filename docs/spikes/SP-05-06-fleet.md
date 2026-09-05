# SP-05 / SP-06 — Fleet: containerised CLI, and the real cell profile

**Status:** COMPLETE — 2026-09-04. EC2 spot `t3.medium`, x86_64, Ubuntu 24.04.4, Docker 29.8.0.

---

## SP-06 — The documented profile matches reality exactly

`docker inspect` of a live cell created by `openclaw fleet create`:

| Control | Observed | Documented |
|---|---|---|
| Capabilities | `CapDrop: [ALL]` | ✅ |
| Privilege escalation | `SecurityOpt: [no-new-privileges]` | ✅ |
| Init process | `Init: true` | ✅ |
| Process limit | `PidsLimit: 512` | ✅ |
| Memory | `2147483648` (2 g) | ✅ |
| CPU | `NanoCpus: 2000000000` (2) | ✅ |
| Restart | `unless-stopped` | ✅ |
| Publishing | `127.0.0.1:19100 -> 18789/tcp` | ✅ loopback only |
| Network | `openclaw-cell-spiketenant-net` — one per cell | ✅ |
| Mounts | `…/fleet/cells/<t> -> /home/node/.openclaw`, `…/auth-profile-secrets/<t> -> /home/node/.config/openclaw` | ✅ |

**§7.4 Layer 1 is validated against a running container, not just docs.** Adopting this profile for
the single-tenant path is sound.

Two details worth carrying into WO-38/39:

- **Fleet does not identity-map.** Host `<state-dir>/fleet/cells/<tenant>` mounts at the standard
  `/home/node/.openclaw`. This independently corroborates SP-01 Q2: the standard container path is
  the right default.
- **Fleet gets ownership right.** The host state tree is owned by uid 1000 — the same numeric
  ownership G25 requires of us.

---

## SP-05 — Containerised Fleet works; no host `npm i -g openclaw`

**Answer: yes, with `--network host`.** ADR 0013's Docker-only stance stands unamended, and WO-57's
blocking question is resolved.

Working invocation:

```bash
docker run --rm --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  --group-add "$(getent group docker | cut -d: -f3)" \
  -e OPENCLAW_STATE_DIR=/var/lib/clawops/fleet \
  -e OPENCLAW_CONFIG_PATH=/var/lib/clawops/fleet/openclaw.json \
  -v /var/lib/clawops/fleet:/var/lib/clawops/fleet \
  --entrypoint openclaw <image> fleet create <tenant> --json
```

Result: cell created, health gate passed, token returned, `fleet list --json` works.

### Four requirements, each found the hard way

1. **`--network host` is mandatory.** Without it, `fleet create` creates a *genuinely healthy* cell
   and then fails its own health gate after 60 s. Fleet probes `127.0.0.1:<cell-port>`, which inside
   the CLI container is the container's loopback, not the host's. The cell was `Up (healthy)` and
   answering `/healthz` from the host the whole time. A caller that treats that error as "creation
   failed" would tear down a working tenant.
2. **The state dir must be identity-mapped.** Fleet computes cell bind-mount sources from
   `OPENCLAW_STATE_DIR`, and the Docker daemon resolves them in the *host* namespace. Note this is
   the opposite of the plain gateway (SP-01 Q2), where identity mapping is unnecessary — so the two
   paths genuinely differ, and WO-57 must not assume WO-39's layout.
3. **Docker socket plus `--group-add <docker gid>`.** The gid is host-specific (988 here); it must be
   read at runtime, never hardcoded.
4. **Fleet defaults to `ghcr.io/openclaw/openclaw:latest`** — an unpinned moving tag. WO-57 must pass
   `--image` with a digest, or every cell drifts independently of the version clawops thinks it pinned.

### Consequence for WO-57

Layer 2 is viable as designed. The plan's stated blocker — "does this force an `npm i -g openclaw` on
the host?" — is answered: no.
