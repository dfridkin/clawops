# ADR 0012 — clawops names the state backend, scoped to what its namespace requires

**Status:** Accepted
**Date:** 2026-09-17
**Deciders:** Project author

## Context

Every cloud stack needs a Pulumi state backend, and until now clawops had no opinion about what
it should be called. Two entry points, two different ways of putting the problem back on the
operator:

`clawops init` wrote a placeholder into the stack and explained it in a line of output:

```ts
: `${defaults.stateScheme}CHANGEME/clawops`     // → s3://CHANGEME/clawops
```

`clawops setup` asked for a name with no default, and told the operator to go and make the
bucket themselves:

```
S3 bucket name: (a storage bucket that tracks what's deployed — create one first if you haven't)
› Required — create a bucket in your cloud console first
```

Three things were wrong with this.

**The wizard argued with itself.** Since the account preflight landed, the wizard offers to
create the state bucket about forty lines after this prompt — with versioning on and public
access blocked, which is more than most people will do by hand. The prompt was sending
operators to do, worse, the job the wizard was about to offer.

**The placeholder reported as somebody else's property.** `CHANGEME` is not a valid S3 bucket
name, and S3 answers `HeadBucket` on it with **403, not 404**. The preflight classifies 403 as
`denied`, which is correct in general and misleading here:

```
✗ State bucket s3://CHANGEME exists
    s3://CHANGEME exists but these credentials cannot read it, or the name belongs to
    another account. Bucket names are global.
```

The operator's actual problem was that they never edited the config.

**The obvious names are gone.** S3 and Cloud Storage share one namespace across every customer
on the platform. An operator inventing a name for the first time reaches for `clawops-state`,
finds it taken, and lands on a 403 — the one case where clawops deliberately offers no fix,
because creating the bucket would fail either way.

## Decision

**clawops derives the name, and a derived name carries exactly the uniqueness its namespace
demands — no more.**

| Provider | Namespace | Derived name | Longest possible |
|---|---|---|---|
| AWS | global, across all customers | `clawops-state-<accountId>-<region>` | 41 / 63 |
| GCP | global, across all customers | `clawops-state-<projectId>` | 44 / 63 |
| Azure | one storage account, named by the operator | `clawops-state` | 13 / 63 |

The lengths are the worst case each cloud permits: AWS account ids are always 12 digits and the
longest region name is 14 characters, and a GCP project id tops out at 30.

Mechanically appending an identifier to all three would have been the obvious design and the
wrong one. An Azure `azblob://` URL names a **container**, which lives inside the storage
account the operator supplies through `AZURE_STORAGE_ACCOUNT` — it is already scoped, and a
subscription GUID would be 37 characters buying nothing. (The 3–24 character limit people
associate with Azure storage belongs to storage *accounts*. clawops never names one: it will
not hold the key that goes with it, which is why `stateBackendCheck` offers no fix.)

**AWS carries the region; the others do not.** An S3 bucket is a regional resource, and Pulumi
reads and writes state on every operation — a bucket on another continent makes every `plan`
and `apply` slower for no reason the operator can see. The cost is one extra bucket per region,
and S3 bills for storage and requests, never for the bucket itself. The alternative, one bucket
per account serving every region, is defensible; this trades a resource that costs nothing for
locality that is otherwise invisible when it goes wrong.

**A name that cannot be derived is not invented.** Where `CHANGEME` used to go, `init` now
fails, naming the credential it wanted and the flag that bypasses it. A stack whose backend
cannot be named is a stack that cannot be deployed, and saying so costs one command.

## Consequences

- `clawops init --provider aws` without credentials now **fails** where it used to write a
  config. The message names both ways forward. `--state` bypasses the lookup entirely, so
  scripted setups that already pass it are unaffected.
- The wizard resolves the account **before** the stack questions rather than during the
  preflight, so a missing credential surfaces before the operator answers another dozen
  prompts.
- Existing configs are untouched. There is no migration: a `stateUrl` already in the config is
  still used verbatim, whatever it is called.
- The provider rules now live in `src/providers/state-bucket.ts` rather than being discovered
  from a creation failure — length, case, reserved prefixes and suffixes, `google` on GCS,
  hyphen placement on Azure.

## Revisit when

A provider changes its naming rules, or clawops grows a reason to create the Azure storage
account itself — which would mean holding its key, and would need R6 revisited first.
