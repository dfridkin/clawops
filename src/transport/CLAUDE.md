# src/transport — SSH Transport Layer

## Connection Pool (`pool.ts`)

`SshConnectionPool` is a module-level singleton keyed by `{user}@{host}:{port}`.

### Configuration

| Parameter | Value | Rationale |
|---|---|---|
| Idle TTL | 5 minutes | Balances resource use against reconnect overhead |
| Max per host | 4 | Prevents SSH server backlog; covers parallel log + exec + tunnel use cases |
| Cleanup interval | 30 seconds | Low-frequency check to avoid waking a sleeping process |

### Lifecycle

- `acquireSession(opts)` — returns `{ session, release() }`. Always call `release()` in a `finally` block.
- `drainPool()` — closes all connections; call on process exit or in test teardown.
- The cleanup timer is `unref()`'d so it never prevents process exit.

### Retry policy

SSH connections are not automatically retried by the pool. The caller is responsible for retry logic. Recommended: 3 attempts with 2s, 4s, 8s backoff (exponential, jitter ±20%). `NetworkError` from `connect()` is always retryable (`retryable: true`).

### Extending in M2

When adding `tunnel` support (SSH port forwarding), add `tunnel(localPort, remoteHost, remotePort)` to `SshSession` in `ssh.ts`. The pool is already structured to support multiple concurrent channel types on a single connection.

## Known Hosts (`ssh.ts`)

Current implementation: **TOFU (Trust On First Use)**. The first connection to a host records the key hash in `known_hosts`. Subsequent connections must match exactly.

**TODO M2:** Replace with full RFC 4253 known_hosts parsing — support `ssh-rsa`, `ecdsa-sha2-nistp256`, `ssh-ed25519` key types.
