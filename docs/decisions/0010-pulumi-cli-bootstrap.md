# ADR 0010. Clawops installs the Pulumi CLI; the Automation API never embedded one

**Status:** Accepted
**Date:** 2026-09-14
**Deciders:** Project author
**Supersedes:** [ADR 0006](0006-embedded-pulumi.md)

## Context

ADR 0006 chose "embed the Pulumi Automation API" over "shell out to the Pulumi CLI", and every
document since has repeated its premise: *the engine is embedded, the user does not install
Pulumi.* `SPEC.md §9` says so, `docs/support-matrix.md` says so, the rule in
`.claude/rules/pulumi.md` forbids shelling out to the binary, and `CLAUDE.md` opens with it.

The premise is false, and was false when it was written. `@pulumi/pulumi/automation` is a
client for the CLI, not a replacement for it. From the installed package:

```js
// node_modules/@pulumi/pulumi/automation/cmd.js
const command = opts?.root ? path.resolve(path.join(opts.root, "bin/pulumi")) : "pulumi";
const { stdout } = await exec(command, ["version"], …);
```

Every `LocalWorkspace` operation spawns that binary. With no `pulumiCommand` option it spawns
bare `pulumi`, so on a machine without one on `$PATH` the first stack operation dies at the
spawn, before any provider code runs, with an error naming a tool the user was told they did
not need.

This was found while preparing the first real cloud end-to-end run, on the author's own
machine, which has no `pulumi`. ADR 0006 ends with a Verification section that names the exact
check: *"`which pulumi` returns nothing on a clean machine, but `clawops up` succeeds."* It was
never run. Every deploy path in clawops has been broken on a clean machine since the beginning;
CI never caught it because unit tests mock `LocalWorkspace` and no test ever spawned the
engine.

## Decision

**Keep the user-facing promise and make it true: clawops installs the CLI itself.**

`PulumiCommand.install({ root })` downloads the CLI matching the bundled SDK, passing
`--no-edit-path`, into a root we choose. `~/.clawops/.pulumi-cli`. The result is handed to
`LocalWorkspace` as `pulumiCommand`. Nothing outside `~/.clawops` is written, `$PATH` is not
edited, and a user's own Pulumi installation is untouched.

Resolution order, in `src/pulumi/cli.ts`:

1. **Our copy** (`~/.clawops/.pulumi-cli`). Pinned to the SDK the programs were written
   against, so it wins when present.
2. **A CLI on `$PATH`**. A compatible CLI already on the machine is worth more than a
   download, and the Automation API version-checks it for us.
3. **Install ours**. Announced on stderr before the download, since a command that appears to
   hang is worse than a slow one that said why.

## Rationale

The alternatives were worse:

- **Document the prerequisite**. Honest, and it gives up the thing ADR 0006 was right about.
  Install friction at a second boundary is real, and the one-command install is a large part of
  why clawops exists rather than a README of Pulumi steps.
- **Vendor the binary in the npm package**. ~200MB across platforms, a package per arch, and
  we would own updating it. Pulumi already publishes an installer for every platform.
- **Reimplement on cloud SDKs**. The option ADR 0006 rejected for good reasons that have not
  changed.

What ADR 0006 got right survives: a pinned version, inline programs, no `pulumi.yaml` on disk,
typed outputs. What changes is the mechanism and one sentence of prose. The cost it listed as
"~50MB bundle" turns out to be a download at first use instead.

## Consequences

**Positive:**
- `clawops apply` works on a clean machine, which it did not before.
- The version we run is the version we pinned, even when the user has another Pulumi.
- `clawops doctor` reports the CLI, found, from where, and at what version.

**Negative:**
- First `apply` on a new machine reaches the network and takes tens of seconds longer. Warned
  about, and only once per machine.
- An offline or locked-down machine needs a manual install. The error says so and links the
  install page.
- The claim "no subprocess JSON parsing" in ADR 0006 was never true either; the Automation API
  does that parsing, we just do not see it.

## Verification

Unlike ADR 0006, these were run:

- `which pulumi` → not found, and `clawops doctor` reports `Pulumi CLI  not installed` with the
  path the first apply will use.
- After one `clawops apply`, `~/.clawops/.pulumi-cli/bin/pulumi version` matches the bundled
  SDK, and `which pulumi` still returns nothing, `$PATH` was not edited.
- A `pulumi` on `$PATH` with no copy of ours is used as-is, with no download.

## Revisit when

Pulumi ships an actually-embedded engine for Node (a WASM or native binding rather than a
subprocess). At that point this ADR's mechanism is obsolete and ADR 0006's original wording
becomes true.
