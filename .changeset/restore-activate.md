---
'@clawops/cli': minor
---

**`clawops backup restore --activate` puts a restored backup into service.** Restoring verified an
archive and then stopped, printing three manual steps whose middle one was a move over live state —
performed by hand, over SSH, by someone who has just had an incident. `--activate` performs it:
stop the gateway, swap the state in, restart, and confirm it answers.

**The state it replaces is kept, not deleted**, and if the gateway does not come up clawops puts
it back and restarts again. A restore that destroys what it replaces is not an improvement on the
manual procedure; it makes the mistake faster and unrecoverable. The state that failed to run is
kept too, under `.failed-restore-<timestamp>`, because it is evidence.

**The staging directory now lives on the host.** It was the container's own `/tmp` — unreachable
from the host, and destroyed by `gateway restart`, which stops, removes and re-runs the container.
A restore staged there could evaporate at the next step of the procedure meant to adopt it, and
the message describing it said "on the host", which it was not.

Free space is checked before an archive is expanded, so a restore refuses early rather than
filling the disk of a machine someone is mid-incident on.
