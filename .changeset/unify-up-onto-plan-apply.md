---
'@clawops/cli': patch
---

`clawops up` deploys to AWS, GCP and Azure, running the same plan → apply path as
`clawops apply`. It gains `--ssh-cidr`, `--gateway-cidr` and `--publish-gateway` with it.

Deploys pin the account they were planned against: `gcp:project` on GCP,
`azure-native:subscriptionId` on Azure.
