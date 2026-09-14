---
'@clawops/cli': patch
---

**Cloud deployments could not work on a machine without Pulumi installed.**

clawops has always said you do not install Pulumi. The Automation API it drives is not an
embedded engine, though — it spawns the `pulumi` binary for every operation:

```js
const command = opts?.root ? path.resolve(path.join(opts.root, "bin/pulumi")) : "pulumi"
```

With none on `$PATH`, every stack command stopped at `spawn pulumi ENOENT`, before any provider
code ran, naming a tool the docs said was not required.

The promise is now true rather than merely stated: clawops installs the CLI matching its
bundled SDK into `~/.clawops/.pulumi-cli` the first time it needs one, announcing the one-time
download on stderr. A compatible `pulumi` already on `$PATH` is used instead, and `$PATH` is
never edited either way. `clawops doctor` reports which one it found, from where, and at what
version.

See ADR 0010, which supersedes ADR 0006.
