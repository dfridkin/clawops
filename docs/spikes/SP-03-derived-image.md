# SP-03 — Derived gateway image with the Docker CLI

**Question.** Does `FROM ghcr.io/openclaw/openclaw:<tag>` + `docker-ce-cli` build and work? Does
`docker` resolve as the non-root `node` user? What is the size delta?

**Changes:** WO-53 — whether a clawops-maintained derived image is the right way to enable the
Docker sandbox backend, or whether something lighter works.

**Why now, when WO-53 ships in 2.1:** if this is infeasible, v2.0.0's documentation cannot promise
sandboxing is coming. Deferring the build is not the same as deferring the answer.

**Established before running:** the official image does **not** ship the Docker CLI —
`OPENCLAW_INSTALL_DOCKER_CLI` defaults to empty in the upstream Dockerfile (line 357).

**Environment:** any Docker host. Note the local host is **arm64**; production targets are
typically amd64, so the size delta is indicative, not exact.

## Result

_pending — image pull in progress_
