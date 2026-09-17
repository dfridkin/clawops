---
'@clawops/cli': patch
---

The setup wizard checks the machine size you chose, not the provider default.

A check the wizard could not perform is reported as unanswered rather than counted as a
failure, and it offers no fix for a check it could not make.
