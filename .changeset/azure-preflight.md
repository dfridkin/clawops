---
'@clawops/cli': patch
---

`clawops doctor --provider azure` checks the subscription, the resource providers a deploy
needs registered, and the azblob credentials Pulumi authenticates to blob storage with.
`clawops setup` runs the same checks and offers to register the providers, naming the change
before making it.
