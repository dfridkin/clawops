---
"@clawops/cli": patch
---

`clawops --version` reported the wrong version

The CLI reported a hardcoded `0.2.0` in `--version` and `--help` — five releases
stale — while `clawops bug` reported the real version from the build-time define.
Two version sources that disagreed, which is why the drift went unnoticed: bug
reports carried the correct version while the CLI told users something else.

Both now read the same define, with a test so a literal cannot creep back in.
