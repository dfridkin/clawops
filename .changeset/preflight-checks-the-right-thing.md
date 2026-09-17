---
'@clawops/cli': patch
---

`clawops doctor --instance-type <size>` points the account checks at the size you are about to
deploy rather than the provider default, and `--provider` checks the provider you name rather
than the one your default stack happens to use.
