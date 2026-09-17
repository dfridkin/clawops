---
'@clawops/cli': patch
---

clawops names the state backend after the account it is deploying into, instead of asking you
for a name or writing a placeholder:

| | derived name |
|---|---|
| AWS | `clawops-state-<accountId>-<region>` |
| GCP | `clawops-state-<projectId>` |
| Azure | `clawops-state` |

A name you type instead is checked against the rules of the cloud that has to accept it.
`clawops init` with no credentials and no `--state` stops and names the credential it needed,
rather than registering a stack that cannot deploy. `--state` still takes any URL verbatim and
existing configs are untouched. See
[ADR 0012](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0012-state-bucket-naming.md).
