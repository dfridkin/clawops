---
'@clawops/cli': patch
---

**A scripted or CI `clawops apply` was silent for minutes.**

The readiness waits report what they are waiting for through `onOutput`, which the apply command
uses to set the spinner's text — and a spinner renders nothing when the output is not a
terminal. So the one case those messages exist for, an operator watching a deploy that takes
four minutes, showed nothing at all.

Waiting notes now travel on their own `onProgress` channel — at most one every 30 seconds, as
against Pulumi's hundreds of lines — and are printed outright when no spinner can show them.
