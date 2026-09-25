---
'@clawops/cli': patch
---

A Docker command that streams — a backup upload, a log follow — no longer trusts what an unrelated
command learned about sudo. The cache recorded whether the *last* command needed escalation, and
that is a property of the command as much as of the host: `uname -s` succeeds unprivileged
everywhere, so running one first stored "no sudo needed" and the upload that followed ran
unescalated. On AWS, where the login user is not in the docker group, that failed with "permission
denied while trying to connect to the docker API" — after the backup had already been taken.
Docker now has its own probe and its own cache, which only a Docker probe writes to.
