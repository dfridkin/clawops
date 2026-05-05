---
description: Rules for SSH transport code
globs:
  - src/transport/**
---

# SSH transport rules

1. **Never shell out to /usr/bin/ssh:** All SSH operations use the `ssh2` npm library directly. No `child_process.exec('ssh ...')` or similar.

2. **AbortSignal everywhere (R13):** Every `connect`, `exec`, `stream`, and `scp` call accepts an optional `signal?: AbortSignal`. Cancellation propagates to the ssh2 session.

3. **knownHostsPath required:** Never use `rejectUnauthorized: false` or equivalent. All connections must verify the host key against a known_hosts file.

4. **privateKeyPath, not inline key:** The private key path comes from `~/.clawops/config.json → ssh.keyPath`. Never accept the key contents as a string in function arguments (avoid accidental logging).

5. **Port forwarding:** `tunnel` uses ssh2's `forwardIn` / `forwardOut`. No netcat, socat, or external binaries.

6. **Error wrapping:** Wrap ssh2 errors in `ProviderError` or a specific `SshError` before bubbling up. Raw ssh2 error messages often contain confusing jargon.

7. **Logging to stderr only:** Any debug output from transport code must go to `process.stderr`, never stdout (MCP stdio mode).
