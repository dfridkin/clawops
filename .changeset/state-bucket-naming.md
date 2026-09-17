---
'@clawops/cli': patch
---

**clawops names the state backend instead of asking you to.**

`clawops init` used to write a placeholder into the stack and explain it in a line of output:

```
s3://CHANGEME/clawops
```

and the setup wizard asked for a bucket name with no default, advising you to "create one first
in your cloud console" — forty lines before the account preflight offered to create it for you,
with versioning on and public access blocked.

The placeholder was worse than blank. `CHANGEME` is not a valid S3 bucket name, so S3 answers
`403`, not `404`, and `clawops doctor` reported it as a bucket **belonging to another account**.

Both now derive the name, and it carries exactly the uniqueness its namespace demands:

| | derived name | longest possible |
|---|---|---|
| AWS | `clawops-state-<accountId>-<region>` | 41 / 63 |
| GCP | `clawops-state-<projectId>` | 44 / 63 |
| Azure | `clawops-state` | 13 / 63 |

An `azblob://` URL names a container inside the storage account you supply, so it is already
scoped — appending a subscription GUID there would be 37 characters buying nothing.

Names you type are checked against the rules of the cloud that has to accept them — length,
case, `xn--` and `-s3alias` on S3, `google` on Cloud Storage, hyphen placement on Azure — rather
than learned from a creation failure after a dozen more questions.

`clawops init` with no credentials and no `--state` now fails, naming the credential it wanted,
rather than writing a stack that can never deploy. `--state` still takes any URL verbatim, and
existing configs are untouched. See ADR 0012.
