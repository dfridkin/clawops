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

## Known Hosts (`known-hosts.ts`)

Standard OpenSSH `known_hosts` parsing. Verification returns one of three verdicts, and
the distinction is load-bearing:

| Verdict | Meaning | Action |
|---|---|---|
| `match` | A key on file for this host matches | Connect |
| `mismatch` | A key on file for this host **differs** | Refuse — this is what verification exists to catch |
| `unknown` | No entry covers this host | Trust on first use; record it |

Supported entry forms: standard three-field, comma-separated host lists, `[host]:port`,
hashed hostnames (`|1|salt|hash`, HMAC-SHA1), `@revoked` and `@cert-authority` markers,
wildcard patterns (`*`, `?`) and negation (`!host`). clawops's legacy two-field hex lines
are still read so existing installs keep working; new entries are written in standard
format so the file stays valid for `ssh` itself.

### Two things not to "simplify"

- **Negation voids an entry outright**, regardless of other patterns in the same list.
  That is how an operator excludes one host from a subdomain wildcard. Honouring `*`
  without `!` would trust a host they explicitly excluded.
- **Wildcards must be honoured, not ignored.** Ignoring them is the *less* safe option:
  an unmatched wildcard falls through to `unknown`, so TOFU accepts a key the user's own
  file contradicts and then records it. Matching turns that into the refusal it should be.
