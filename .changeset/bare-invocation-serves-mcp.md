---
'@clawops/cli': patch
---

**`clawops` with no command, started over a pipe, serves MCP instead of printing help.** The
things that start MCP servers routinely start them by running the package's binary with no
arguments. Glama's directory build did exactly that three times — got the CLI's help text where
it wanted a handshake, and withheld the listing each time — and no fix in this repository reached
it, because its stored build spec never consults the Dockerfile.

The condition is narrow: no arguments at all, and stdin is not a terminal. Typed at a prompt,
`clawops` still prints help; so does `clawops | less`, because stdin is still the terminal there.
A flag with no command is still a malformed invocation. When it does start the server it says so
on stderr, never stdout, which carries the protocol.

`pnpm verify:docker` now probes the image both ways — through its ENTRYPOINT, and with the bare
binary a directory infers — so the invocation that failed three times is one a release cannot
break again.
