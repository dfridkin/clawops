---
"@clawops/cli": minor
---

GCP hosts no longer run as the project's default compute service account. That account carries the `cloud-platform` scope and, on most projects, the Editor role, so any process on the host could act on the whole project. Nothing on the host calls a Google API, so the VM now has no service account. On an existing stack the next `clawops up` removes it, which stops and starts the VM; the boot disk is untouched.
