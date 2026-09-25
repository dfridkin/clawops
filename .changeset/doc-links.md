---
'@clawops/cli': patch
---

**The recovery docs no longer describe a procedure that is now a flag.** The backup guide and the
upgrade-rollback guide both told the reader that recovery was manual, budget real time for it, and
it is not a one-liner on this release line — written before `--activate` existed and left standing
after it shipped. Both now name the command, and the disaster-recovery checklist no longer asks for
a `gateway restart` that `--activate` performs itself.

Three links in those guides pointed at `#recovering-from-an-archive`, a heading that had been
renamed, and one in the local-VM example pointed at a README section that no longer exists under
that name. CI now follows every in-repo Markdown link and anchor (`pnpm verify:docs`): a renamed
heading leaves the surrounding prose reading correctly and the link going nowhere, which is
precisely what review does not catch.
