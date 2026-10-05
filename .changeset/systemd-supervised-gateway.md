---
'@clawops/cli': patch
---

**On a local-provider host, restarts, updates, migrations and restores no longer race systemd.**
The local provider runs the gateway as the `openclaw` systemd unit with `Restart=always`, and the
unit removes any container called `openclaw` before starting its own. clawops replaced the
container directly, so about five seconds later systemd removed clawops' container and ran the one
its unit names: a restart could be undone, an update reverted to the old version, a migration
caught half-started. Whether it happened depended on timing, which is why it passed most runs.

On a host with that unit, clawops now hands the new run command to systemd as a drop-in and
restarts the unit, and stops the gateway through the unit when it needs it stopped. Cloud hosts,
which run the gateway as a detached container, are unchanged. Re-running `clawops up` clears the
drop-in, so the unit it writes is the one that runs.
