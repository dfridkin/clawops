# ADR 0011. Clawops generates and stores the Pulumi state passphrase

**Status:** Accepted
**Date:** 2026-09-14
**Deciders:** Project author

## Context

clawops keeps Pulumi state in the operator's own object storage, `gs://`, `s3://`, Azure Blob.
These are Pulumi's *self-managed* backends, and they have no key service behind them. Every
stack still needs a secrets manager, and the only one available without a cloud KMS is a
passphrase, so creating a stack fails before anything is provisioned:

```
error: could not create secrets manager for new stack: passphrase must be set with
PULUMI_CONFIG_PASSPHRASE or PULUMI_CONFIG_PASSPHRASE_FILE environment variables
```

clawops never set one. `clawops plan` swallowed this as a one-line warning and produced a plan
with no diff; `clawops apply` could not create a stack at all. The CI guide
(`docs/github-actions-oidc.md`) has told people to set `PULUMI_CONFIG_PASSPHRASE` from a GitHub
secret since the beginning. The local path had no story, and the failure named a variable
nothing in clawops' own documentation mentioned.

R6 is the tension: *never store cloud credentials in clawops config.*

## Decision

**Generate a passphrase on first use and store it at `~/.clawops/secrets/pulumi-passphrase`,
mode `0600`.** An operator who sets `PULUMI_CONFIG_PASSPHRASE` or
`PULUMI_CONFIG_PASSPHRASE_FILE` themselves is left alone; clawops sets nothing in that case.

R6 is not violated. R6 governs *cloud credentials*, issued by a provider, belonging to the
operator, revocable, and usable against real infrastructure by anyone who obtains them. This is
a local encryption key clawops generates for its own state file, alongside the gateway tokens
already kept in `~/.clawops/secrets/`. It grants nothing on its own.

## Alternatives

- **Prompt for a passphrase on every deploy.** Correct, and the end of the one-command
  promise. It also pushes the operator toward a memorable passphrase, which is a weaker key
  than 32 random bytes.
- **Ship a fixed passphrase.** Then it is not a passphrase.
- **Require the operator to set the variable.** What happens today, except silently and with
  an error message that names Pulumi rather than clawops. It remains available and takes
  precedence for anyone who wants it.
- **Use a cloud KMS key per provider** (`awskms://`, `gcpkms://`). Better key management, and
  it makes the state backend depend on a second cloud resource clawops would have to create,
  pay for and destroy. Worth revisiting when clawops manages a KMS key anyway.

## Consequences

**Positive:**
- `plan` produces a real diff and `apply` can create a stack, neither worked on a fresh
  machine before.
- The key is 32 random bytes, not something a person chose.
- `clawops doctor` reports which of the three states the machine is in.

**Negative:**
- **Losing `~/.clawops/secrets/pulumi-passphrase` makes that machine's stack secrets
  unreadable.** This is the one piece of clawops state that cannot be regenerated: config can
  be rewritten, SSH keys replaced, stacks redeployed. `doctor` says to back it up.
- Deploying the same stack from a second machine requires copying the file (or setting
  `PULUMI_CONFIG_PASSPHRASE` on both). A stack's secrets manager is fixed when the stack is
  created, so this cannot be repaired after the fact by changing the passphrase.
- One more file in `~/.clawops/secrets/` that a backup of the home directory will contain.

## Verification

- On a machine with no passphrase: `plan` produces a diff, and the file appears with mode
  `0600`.
- A second `plan` reuses the same value rather than rotating it.
- With `PULUMI_CONFIG_PASSPHRASE` exported, no file is created and the operator's value is used.

## Revisit when

clawops manages a cloud KMS key for other reasons, or Pulumi offers a self-managed backend with
a secrets manager that does not need one.
