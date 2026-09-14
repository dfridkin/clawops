---
'@clawops/cli': patch
---

**`clawops apply` built its SSH connection with an empty key path.**

```
Cannot read SSH private key at : ENOENT: no such file or directory, open ''
```

`getConnectionInfo` reads `privateKeyPath` and `knownHostsPath` out of the object it is handed,
and a stack's outputs do not contain them — they are the operator's, from
`~/.clawops/config.json`. Every other caller merges them in first:

```ts
ctx.adapter.getConnectionInfo({ ...base, privateKeyPath: ctx.config.ssh.keyPath, … })
```

apply passed raw stack outputs. That was true of its config-overlay step from the beginning —
so any plan carrying `openclaw.config` would have failed on a real deployment — and the new
readiness wait inherited the same call shape. Both go through one helper now, which also
expands `~`, since `ssh2` opens the path verbatim.
