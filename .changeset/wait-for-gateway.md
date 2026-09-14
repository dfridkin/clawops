---
'@clawops/cli': patch
---

**`clawops apply` reported success before OpenClaw existed.**

Waiting for SSH is not the same as waiting for the deployment. The startup script pulls a ~3GB
image, so for the first minutes after a successful apply:

```
Remote health
✗  Container    not found
✗  Gateway      no response from the gateway
```

and `logs`, `gateway`, `config`, `agents` and `doctor --stack` all fail at whatever you try
first.

apply now waits for the gateway to answer `/startupz` — the probe `doctor` already uses —
before reporting success, and says what it is waiting for every half minute rather than going
silent through a long download. A running container is not accepted as a working gateway: that
distinction is why `/startupz` exists. The container's state is read alongside the probe, so a
timeout can say whether an image was still downloading or a container started and exited; both
look like "no response" from outside and need different answers.
