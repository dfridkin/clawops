---
"@clawops/cli": minor
---

A host agent now reports other agents that can run commands, read or write files, or change the gateway configuration inside the gateway container. On a default deployment every agent can, and any of them could read the clawops token from `openclaw.json` and the host agent's transcripts from disk. `clawops_status` lists them as `otherAgentsInContainer`. A host agent installed with `--strict` refuses every call while any exist.
