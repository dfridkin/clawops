---
'@clawops/cli': patch
---

**`clawops plan` → `clawops apply` had never deployed anything.** Three faults, each hiding the
next, found by running the path end to end for the first time.

**Stack config was written twice and disagreed.** `generatePlan` set three keys before its
preview; `applyPlan` set six. Neither set `sshPublicKey`, which every cloud program requires:

```
error: Stack config "sshPublicKey" is required for the GCP adapter.
```

So the preview failed on every cloud plan ever generated — surfaced as one line of warning and
an empty `diff` section — and apply could not create an instance. Both now write stack config
through the same function, so a preview shows what an apply would do.

**The plan did not record which key may log in.** It does now, in `spec.ssh.publicKey`,
resolved from `ssh.keyPath`: the `.pub` beside the private key, or derived from the private key
through `ssh2` when there is none.

**A self-managed state backend needs a passphrase.** `gs://`, `s3://` and Azure Blob have no key
service, so a new stack cannot create a secrets manager without one. clawops generates one at
`~/.clawops/secrets/pulumi-passphrase` (mode `0600`) and yields to `PULUMI_CONFIG_PASSPHRASE`
when the operator sets it. **Back that file up** — losing it makes that stack's secrets
unreadable. See ADR 0011.

Also fixed:

- `clawops doctor` checks that your SSH key is one `ssh2` can use. A readable PKCS#8 PEM passed
  the old check and then failed at every connect. It also reports the Pulumi CLI and the state
  passphrase.
- Egress-IP detection asks for `text/plain` and validates the answer. `ifconfig.me` serves an
  HTML page to anything that does not look like curl, so the "detected IP" was a 4KB document
  on its way into a firewall rule.
- A preview no longer counts the same resource once per section: "7 to create" for a stack that
  creates four.
