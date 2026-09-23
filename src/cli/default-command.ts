/**
 * What to run when clawops is given nothing.
 *
 * clawops is a CLI first, so a person who types `clawops` gets help. But it is also an MCP
 * server, and the things that start MCP servers routinely start them by running the package's
 * binary with no arguments — Glama's directory build did exactly that three times, got the help
 * text where it wanted a handshake, and withheld the listing each time. An operator cannot fix
 * that from their side, and every other directory that infers how to run a server can make the
 * same guess.
 *
 * So: no arguments at all, and stdin is not a terminal, means something is driving this process
 * over a pipe — which is how every MCP client starts a server, and is not how a person uses a
 * CLI. That, and only that, starts the server.
 *
 * The stdin check is what keeps the CLI's behaviour intact. `clawops` typed at a prompt still
 * prints help; so does `clawops | less`, because stdin is still the terminal there. A flag with
 * no command (`clawops --json`) is a malformed CLI invocation and still reports as one.
 */
export function resolveArgv(argv: readonly string[], stdinIsTty: boolean): string[] {
  if (argv.length === 0 && !stdinIsTty) return ['mcp', 'serve']
  return [...argv]
}
