---
"@clawops/cli": patch
---

`clawops_logs_tail` now reads the gateway's own logs. Since 2.0.1 it had fallen back to container output on every host, saying "the gateway is not answering" when it was: the probe it runs reports through its exit code, and the tool was still looking for `ok` on stdout. `clawops logs` was not affected.
