# SP-04 — DooD sandboxing

**Status:** COMPLETE (with one caveat) — 2026-09-04. EC2 spot `t3.medium`, x86_64,
Ubuntu 24.04.4, Docker 29.8.0, derived image `clawops-openclaw:2026.8.1-dockercli`.

**Verdict: D4 is feasible. Sandboxing works — and it requires identity path mapping,
which a plain gateway does not.**

## What worked

| Step | Result |
|---|---|
| Sandbox image built on host from the documented inline Dockerfile | ✅ 309 MB |
| Gateway starts with `agents.defaults.sandbox` config | ✅ healthy |
| Docker daemon reachable from inside the gateway | ✅ `uid=1000(node) groups=1000,988`, daemon 29.8.0 |
| Sandbox config survives strict validation | ✅ `mode=all`, `backend=docker` read back |
| `openclaw sandbox explain` | ✅ full effective policy, mounts, tool allow/deny |

Requirements confirmed: derived image with `docker-ce-cli` (SP-03), `/var/run/docker.sock` mounted,
`--group-add <host docker gid>` (988 here — host-specific, must be read at runtime).

## The finding: identity mapping is required, and its absence is silent

`sandbox explain` computes workspace mounts as **container-internal paths**:

```
workspaceMounts:
  - /home/node/.openclaw/sandboxes/workspace-b191…  -> /workspace ro
  - /home/node/.openclaw/workspace                  -> /agent     ro
```

Those become bind-mount *sources* for sibling containers, and the Docker daemon resolves them in the
**host** namespace — where they do not exist (`ls: cannot access '/home/node/.openclaw'`; the real
host path is `/var/lib/clawops/sb`).

Simulated directly, with a marker file in the real workspace:

```
A) source = container-internal path   →  /agent contains: []          ← EMPTY
   host side: Docker silently created /home/node/.openclaw/workspace, root-owned, empty

B) source = identity-mapped host path →  /agent contains: marker.txt
                                          REAL-WORKSPACE-MARKER
```

**Docker auto-creates a missing bind source as an empty directory rather than failing.** So without
identity mapping the agent gets an empty workspace, no error is raised, and root-owned junk
accumulates on the host. That is worse than a crash: the agent reports success having seen nothing.

### Consequence for WO-39 and WO-53

SP-01 Q2 established the standard container path is sufficient for a plain gateway. SP-04 establishes
sandboxing needs identity mapping. **Both are true, so the layout is conditional:**

| Deployment | State mount |
|---|---|
| Default (no sandbox) | Standard `/home/node/.openclaw` — matches upstream and Fleet |
| Sandbox enabled | **Identity-mapped** — host path == container path |

The earlier draft's "identity-map unconditionally, one layout beats two" was the right instinct for
the wrong reason; the conditional is now evidence-based rather than assumed. It also reinforces the
existing risk note that sandboxing is an all-or-nothing consent at provision time: switching it on
changes the mount set, so it cannot be toggled by config alone.

## AppArmor / unprivileged user namespaces

Ubuntu 24.04 ships `kernel.apparmor_restrict_unprivileged_userns = 1`, and `unshare --user` is
blocked both inside the gateway container and inside a `--cap-drop=ALL` sandbox container.

This is the constraint upstream documents for the **Codex harness's** `workspace-write` shell
(`bwrap: setting up uid map: Permission denied`). It does not affect OpenClaw's own sandbox tools.
Record it in `docs/limitations.md`: on default Ubuntu hosts, Codex `workspace-write` inside a
sandbox needs an AppArmor profile granting the namespace, and the host-wide
`kernel.apparmor_restrict_unprivileged_userns=0` fallback is a posture change we should not make on
the user's behalf.

## Caveat — what this spike did not exercise

Sandbox containers are created **lazily, on the first tool call**, which needs a configured model
provider. `openclaw sandbox recreate` only rebuilds existing runtimes. So the config path, mount
computation, daemon access and image availability are all verified; an end-to-end tool execution
inside a spawned sandbox is not.

The path-mapping failure was proven by direct simulation rather than observed in a live sandbox.
That is sufficient to settle the WO-39 conditional, but WO-53 should close the loop with a real
model-backed session before shipping.

## Assertions to graduate

1. When `sandbox.enabled`, the rendered run command identity-maps the state dir. *(unit)*
2. When sandboxing is off, the standard container path is used. *(unit)*
3. `--group-add` uses a docker gid read at runtime, never a literal. *(unit)*
4. `openclaw sandbox explain` mounts resolve to existing host paths. *(VM)*
