---
"@clawops/cli": patch
---

Bootstrap retries `apt-get update` when a package mirror is caught mid-sync. Both the local bootstrap and the cloud startup script used to stop on the first `Hash Sum mismatch`. They now retry twice more, 30 s and then 60 s later, asking any cache in between for a fresh copy, and package downloads retry dropped connections.
