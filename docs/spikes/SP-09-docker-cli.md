# SP-09 — Can we drive the sandbox backend without a derived image?

**Status:** COMPLETE — 2026-09-05. EC2 spot `t3.medium`, x86_64, ECS-optimized AL2023
(Docker 25.0.16 preinstalled), OpenClaw `2026.9.1`.

**Answer: yes. Option A works, and WO-53 does not need a clawops-published image.**

## The question

WO-53 assumed clawops must publish and maintain a derived gateway image, because the official
`ghcr.io/openclaw/openclaw` ships no Docker CLI (`OPENCLAW_INSTALL_DOCKER_CLI` defaults empty) and
the sandbox backend shells out to `docker`. That assumption went from "the image lacks a binary"
straight to "therefore we own an image", without testing the step between.

## Result — official image, unmodified

Docker publishes standalone **statically linked** CLI binaries at
`download.docker.com/linux/static/stable/<arch>/`. Fetched, verified, mounted read-only:

```
binary : 41 MB, statically linked
mount  : -v /opt/clawops/bin/docker:/usr/local/bin/docker:ro
```

Inside the unmodified official image:

```
id                → uid=1000(node) gid=1000(node) groups=1000(node),994
command -v docker → /usr/local/bin/docker
docker version    → CLI 28.5.2 -> daemon 25.0.16
```

Gateway with `sandbox.mode: all`:

```
status   : running exit=0
startupz : {"ok":true,"status":"started"}
sandbox explain → backend: docker, runtime: sandboxed, mounts computed
```

And the decisive test — spawning a sibling sandbox **from inside** the gateway, through the mounted
CLI:

```
spawned-by-mounted-cli
SP09-MARKER                          ← read through the bind mount
capdrop=[ALL] secopt=[no-new-privileges] net=none
```

The sibling gets the hardened profile, and the workspace bind resolves host-side.

## Why this beats the derived image

| | Option A — mounted static CLI | Option B — derived image |
|---|---|---|
| Image | official, **unmodified** | `FROM` official, +70 MB (SP-03) |
| Registry | none | ours to publish |
| CVE surface | none of ours | ours, per supported version |
| CI | none | build + push per OpenClaw release |
| Digest pinning | Docker's own release artifact | ours to manage |
| Version skew | CLI/daemon negotiate (28.5.2 ↔ 25.0.16 verified) | image rebuilt per base tag |

Both add a host-side bootstrap step, and **that step already exists**: SP-04 established the sandbox
image `openclaw-sandbox:bookworm-slim` must be built on the host regardless, because OpenClaw fails
fast rather than substituting `debian:bookworm-slim`. Fetching one more artifact is not a new class
of work; publishing an image is.

## What WO-53 should do

1. Fetch the pinned static CLI during bootstrap, verify its checksum, install to
   `/opt/clawops/bin/docker`.
2. Mount it read-only at `/usr/local/bin/docker` alongside the socket and `--group-add <docker gid>`
   read at runtime.
3. Keep **Option B as the fallback** — SP-03 proved the derived build works — for a host that cannot
   reach `download.docker.com`, or an air-gapped install.
4. Drop the "we will maintain a container image" risk from the plan.

Worth doing in parallel: ask upstream for a `-dockercli` variant. They already publish `slim`,
`-browser` and `extended-stable-*`, so it is a reasonable request — and it would remove even the
mounted binary.

## Caveats

- Host distro here was AL2023, not Ubuntu. Fine for this question — it tests container-side CLI
  behaviour, not host LSM policy. SP-04's AppArmor/userns finding remains Ubuntu-specific and
  unchanged.
- Version skew was verified in one direction only (newer CLI, older daemon), which is the direction
  that matters when a host lags. Pin the CLI version in `spec/openclaw-versions.yaml` rather than
  tracking `stable`.
- A sandbox spawned by a real model-backed session still hasn't been exercised; as in SP-04, the
  mechanism is proven by direct simulation.

## Assertions to graduate

1. Bootstrap installs the static CLI and verifies its checksum. *(unit)*
2. The rendered run command mounts it read-only at `/usr/local/bin/docker`. *(unit)*
3. `docker version` succeeds from inside the gateway container. *(VM)*
4. A sibling container spawned from inside gets `cap-drop=ALL` and `network=none`. *(VM)*
