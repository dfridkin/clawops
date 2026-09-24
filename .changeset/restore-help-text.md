---
'@clawops/cli': patch
---

`clawops backup --help` no longer says restore is unavailable. It has worked since 2.0: it
verifies an archive and expands it into a staging directory on the host, leaving adoption as a
deliberate manual step. The help text was left over from 1.7.5, when the OpenClaw of the day had
no restore subcommand to call, and it outlived the reason.
