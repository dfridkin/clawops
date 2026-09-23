---
'@clawops/cli': patch
---

**The Dockerfile had never been built, and did not build.** `npm pack --pack-destination /out`
fails with ENOENT because npm does not create that directory. The image exists so the Glama MCP
directory can build the server and decide whether to list it; unable to build it, Glama inferred
a spec of its own, ran `clawops` with no subcommand, got the CLI's help text where it wanted a
handshake, and withheld the listing. One `mkdir` was the whole fix.

`pnpm verify:docker` now builds the image and runs the MCP protocol probe against the running
container — the same checks the local server passes, against the artifact a directory actually
evaluates — and it runs in CI as a job of its own.
