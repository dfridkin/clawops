---
"@clawops/cli": patch
---

The `clawops://stacks/{name}/last-run` resource refuses a name that is not a stack name. It used to join the name from the URI into a path, so `../` could read a `*.last-run.json` file outside `~/.clawops/state`.
