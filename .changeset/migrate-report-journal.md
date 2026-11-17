---
"@clawops/cli": patch
---

`clawops migrate` no longer fails on 1.x workspaces that 2.x refuses to start on ("Legacy workspace setup state requires migration … run openclaw doctor --fix"). When a second start is not enough, it stops the gateway, runs a one-shot `openclaw doctor --fix` on the state in a throwaway container, and starts it once more, as `gateway update` already did. When the gateway still does not start on a systemd host, the failure report now shows the unit's journal instead of `docker logs`, which had nothing to show because the gateway runs there with `--rm`.
