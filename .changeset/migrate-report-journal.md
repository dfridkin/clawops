---
"@clawops/cli": patch
---

`clawops migrate`: when the 2.x gateway does not start on a systemd host, the failure report now shows the unit's journal. It showed `docker logs`, but the gateway runs there with `--rm`, so a container that had exited left only "No such container".
