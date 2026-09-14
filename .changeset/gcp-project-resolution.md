---
'@clawops/cli': patch
---

**`gcloud config set project` — the thing clawops told you to do — did nothing.**

The GCP preflight check resolved the project from four environment variables and printed this
when it found none:

```
✗ GCP project is set   No project resolved. Set GOOGLE_CLOUD_PROJECT, or run
                       `gcloud config set project <id>`.
```

The second half of that remedy was never implemented: nothing read gcloud's configuration, so
an operator who followed the advice saw the same failure and no reason why.

clawops now reads `core/project` from the active gcloud configuration (honouring
`CLOUDSDK_CONFIG` and `active_config`), after the environment variables and including
`GOOGLE_PROJECT`, which the Pulumi GCP provider checks first and clawops did not check at all.

`apply` also pins the resolved project as the stack's `gcp:project`, so a deploy lands in the
project whose APIs and state bucket `doctor` verified rather than in whichever one the
environment names at apply time.
