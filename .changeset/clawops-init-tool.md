---
'@clawops/cli': minor
---

**`clawops_init` registers a stack over MCP, so a client can bootstrap from nothing.** Every
clawops tool needs a config, and creating one was a terminal-only act — so on a machine that had
never run clawops, every tool refused and told the caller to run a command it could not run. In a
directory's sandbox that is the entire server: an evaluator opens the inspector, tries a tool,
and is told to use a terminal they do not have. The tool writes `~/.clawops/config.json` and
generates an SSH key; it provisions nothing and costs nothing. Adding a stack is additive, and
overwriting one still needs `force`.

**The published image was missing two packages clawops cannot work without.** `node:*-slim`
ships no `ssh-keygen`, so `init` could not make a usable key — and no CA bundle, so every HTTPS
call from inside the container failed to verify: the Pulumi CLI download on first use, and every
cloud API call after it, credentials or not. The container could reach nothing. Both are
installed now, and a test asserts the Dockerfile keeps them.

The "no config" message names the tool that fixes it rather than a command an agent cannot run.
