---
"@clawops/cli": patch
---

`clawops config set|unset --restart` restarts the gateway the way `clawops gateway restart` and `clawops_config_set` do. It had its own restart, which brought a gateway deployed with `--publish-gateway all` back on loopback only, fell back to the moving `stable` tag when it could not read the running image, and reported success before the gateway had started.
