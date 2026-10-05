---
'@clawops/cli': patch
---

**A secret name can no longer reach outside the secrets directory.** `clawops secret delete
../config.json --yes` deleted `~/.clawops/config.json`, and `set` and `rotate` wrote outside the
directory the same way, because a secret's path was its name joined onto the directory with no
check. A name is now a single file name inside the secrets directory: no `/` or `\`, not `.` or
`..`, and nothing that resolves elsewhere. Anything else is refused, with exit code 2.
