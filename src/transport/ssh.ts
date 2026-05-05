// SSH transport — not yet implemented (M1).
// Uses ssh2 library. Never shells out to /usr/bin/ssh. Per R13: AbortSignal on all calls.

export interface SshConnectOpts {
  host: string
  port: number
  user: string
  privateKeyPath: string
  knownHostsPath: string
  signal?: AbortSignal
}

export interface SshSession {
  exec(command: string, signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number }>
  close(): void
}

/** Connect to a remote host via SSH. Not yet implemented. */
export async function connect(_opts: SshConnectOpts): Promise<SshSession> {
  throw new Error('ssh transport: not yet implemented (M1)')
}
