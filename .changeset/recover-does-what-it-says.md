---
'@clawops/cli': patch
---

**`clawops_workflow_recover` runs the stack's health checks, and recommends only tools that
exist.** It described four steps and ran two, status and logs, and finished by sending agents to
`clawops refresh`, a command clawops does not have. It now also runs the health checks
`clawops_doctor` runs for a stack and reports the ones that failed, and its next steps name the
tool for each kind of failure: restart, update, restore, re-run `up`, or plan and apply. The
combined report is held to the 8 KB output cap.
