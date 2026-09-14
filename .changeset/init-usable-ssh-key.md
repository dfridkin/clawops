---
'@clawops/cli': patch
---

**`clawops init` generated an SSH key that clawops cannot use.**

It called `crypto.generateKeyPairSync('ed25519', { privateKeyEncoding: { type: 'pkcs8' } })`,
which writes a PKCS#8 PEM. That is a valid ed25519 key, and neither `ssh2` — the library every
clawops SSH operation uses — nor OpenSSH itself can read it:

```
$ ssh-keygen -y -f ~/.clawops/id_ed25519
Load key "~/.clawops/id_ed25519": invalid format
```

So `init` produced a key the tool that produced it could not use, and every `ssh`, `logs`,
`tunnel` and `harden` against a stack deployed with it would have failed at connect time.
`doctor` reported `✓ SSH key` because it checked the file was readable.

`init` now uses `ssh-keygen`, as the setup wizard already did, writes the `.pub` beside it, and
refuses with instructions if `ssh-keygen` is unavailable rather than writing a config that
points at a key that does not exist. `doctor` parses the key rather than stat-ing it.

**If you ran `clawops init` before this release**, check `clawops doctor`. If it reports the key
is unusable, regenerate it:

```bash
ssh-keygen -t ed25519 -f ~/.clawops/id_ed25519 -N '' -C clawops
```

An already-deployed instance keeps the old public key in its `authorized_keys`; redeploy or add
the new public key to the host.
