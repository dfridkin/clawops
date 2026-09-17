---
'@clawops/cli': patch
---

clawops installs the Pulumi CLI it needs into `~/.clawops/.pulumi-cli` the first time it needs
one, announcing the one-time download, and uses a compatible `pulumi` already on `$PATH`
instead when there is one. `$PATH` is never edited. `clawops doctor` reports which one it
found, from where, and at what version. See
[ADR 0010](https://github.com/dfridkin/clawops/blob/main/docs/decisions/0010-pulumi-cli-bootstrap.md).
