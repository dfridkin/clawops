---
"@clawops/cli": patch
---

Prepare the two release lines: 1.x maintenance, 2.x current

clawops 2.x and 1.x target incompatible OpenClaw runtimes, so the project ships two lines
rather than one that deploys either badly. This wires the release path for both.

`scripts/ci-publish.sh` takes an optional dist-tag, and the 1.x branch passes `v1`.
Without it `changeset publish` defaults to `latest`, so the first 1.x patch released after
2.0.0 would take `latest` back and start serving 1.x to everyone running a fresh install.

The release workflow now runs on both branches from one file, so it does not have to be
fixed twice. MCP registry publishing stays on `main` only: the registry serves one current
version per server, and a 1.x patch would drag the entry backwards for every client that
discovers clawops through it.

The support policy is now written down — dist-tags, the OpenClaw range each line accepts,
what gets backported, and a fixed end-of-life date of 2027-03-31 for 1.x, recorded as a
date rather than a duration so it cannot quietly move.
