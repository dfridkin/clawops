# SP-14. Can a host agent tell which tailnet peer is calling it?

**Status:** COMPLETE. 2026-10-17. Local Docker only: Docker 29.6.2 (Docker Desktop, linux/arm64,
kernel 6.12.76-linuxkit), **Headscale v0.27.1** as the control server, **tailscale/tailscale:v1.88.3**
nodes (Alpine 3.19, tailscaled 1.88.3). No real Tailscale account; see *What transfers* at the end.

**Question for ADR 0015:** a host agent answers read calls from peer host agents over the tailnet,
authenticated by the caller's tailnet identity instead of a token. Can it learn that identity
reliably, from an unprivileged process, and can anything else pass for a peer?

---

## Setup

| Node | Mode | Joined with | Tags (control plane) |
|---|---|---|---|
| `sp14-a` | kernel (tun, `NET_ADMIN` + `/dev/net/tun`) | tagged preauth key (`preauthkeys create --tags tag:clawops-agent`) | `tag:clawops-agent` (forced) |
| `sp14-b` | kernel | untagged key + `tailscale up --advertise-tags=tag:clawops-agent`, owner in policy `tagOwners` | `tag:clawops-agent` (valid) |
| `sp14-c` | kernel | untagged key | none, user `spike` |
| `sp14-u` | userspace (`TS_USERSPACE=true`) | tagged preauth key | `tag:clawops-agent` |
| `sp14-x` | no tailscaled | on the same Docker network (`sp14-net`) | not a tailnet node |

Both tagging paths work on Headscale 0.27.1. Policy:
`{"tagOwners":{"tag:clawops-agent":["spike@"]},"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}`.
Headscale insists on a DERP map, so a placeholder region (`derp.invalid`) was configured; nodes
connect directly over the Docker network.

The listener (`srv.py`) accepts on port 18791 and, **while the connection is open**, asks the LocalAPI
`GET /localapi/v0/whois?addr=<remote ip:port>` and logs the result.

---

## Findings

### 1. whois names the calling node and its tags. Kernel mode, listener on the tailnet IP

```
# sp14-b: python3 /srv.py 100.64.0.2 18791 ; sp14-a and sp14-c: curl telnet://100.64.0.2:18791
ACCEPT 100.64.0.1:59554 HTTP 200 26.1ms {"Node.Name": "sp14-a.sp14.test.", "Node.Tags": ["tag:clawops-agent"], "Node.User": 1, "UserProfile.LoginName": "spike", "UserProfile.ID": 1}
ACCEPT 100.64.0.3:48016 HTTP 200 3.7ms  {"Node.Name": "sp14-c.sp14.test.", "Node.Tags": null, "Node.User": 1, "UserProfile.LoginName": "spike", "UserProfile.ID": 1}
```

The fields that identify the caller, from `tailscale whois --json 100.64.0.1:59554`:

```json
"Node": { "ID": 1, "StableID": "1", "Name": "sp14-a.sp14.test.", "User": 1,
          "Tags": ["tag:clawops-agent"], "Addresses": ["100.64.0.1/32", "fd7a:115c:a1e0::1/128"],
          "ComputedName": "sp14-a", "Hostinfo": { "Hostname": "sp14-a", "OS": "linux", ... } },
"UserProfile": { "ID": 1, "LoginName": "spike", "DisplayName": "spike" },
"CapMap": null
```

- **`Node.Tags` is the field to authorise on.** It is assigned by the control plane: a tagged key or
  an advertised tag the policy's `tagOwners` allowed. `sp14-a` sees `sp14-b`'s advertised tag the same way
  (`b seen from a: sp14-b.sp14.test. ['tag:clawops-agent']`).
- **`Hostinfo` is self-reported by the peer** (hostname, OS, versions) and must never be used for
  authorisation.
- The untagged device has `Tags: null` and a `UserProfile`. On Headscale the **tagged** node also
  carries its creating user's profile (`spike`); see *What transfers*.
- In kernel mode whois resolves by IP: `whois 100.64.0.1:1` (a made-up port) still returns `sp14-a`.
- **A retag shows up at once.** `headscale nodes tag -i 1 -t tag:other` made `sp14-b`'s whois of `sp14-a`
  answer `['tag:other']` within 2 s. Taking a tag away takes effect on the next call, with no cache to flush.

### 2. Userspace networking works too, but the listener sees loopback

```
# sp14-u (TS_USERSPACE=true): only lo and eth0; no tailnet interface
bind tailnet IP:  OSError: [Errno 99] Address not available
# listener on 127.0.0.1:18791, after `tailscale ping` from a and c
ACCEPT 127.0.0.1:53888 HTTP 200 55.0ms {"Node.Name": "sp14-a.sp14.test.", "Node.Tags": ["tag:clawops-agent"], ...}
ACCEPT 127.0.0.1:53894 HTTP 200 17.3ms {"Node.Name": "sp14-c.sp14.test.", "Node.Tags": null, ...}
```

- In userspace mode there is no tailnet address to bind. Tailscale's netstack forwards inbound tailnet
  TCP to the local listener **from `127.0.0.1:<ephemeral port>`**, and whois on that exact `127.0.0.1:port`
  maps back to the real caller. Here the port matters, unlike in kernel mode.
- A mapping that is gone fails closed: two connections that had stalled before the direct path came up
  were delivered late and answered `404 no match for IP:port`.
- **A local process connecting to the same loopback listener is not attributed to anyone:**
  `ACCEPT 127.0.0.1:45120 HTTP 404 ... "no match for IP:port"`.
- tun was available in Docker Desktop (`--cap-add NET_ADMIN --device /dev/net/tun`), so both modes were
  measured.

### 3. A non-root process can call whois, and cannot change anything

In the official image the socket is `srw-rw-rw- root /tmp/tailscaled.sock`, reached through a symlink in
`drwx------ root /var/run/tailscale`. As uid 1500:

```
curl --unix-socket /var/run/tailscale/tailscaled.sock .../whois  -> connect: permission denied   (0700 directory)
curl --unix-socket /tmp/tailscaled.sock .../whois?addr=100.64.0.1:1   -> HTTP 200, full whois JSON
tailscale --socket=/tmp/tailscaled.sock whois 100.64.0.1               -> Machine: sp14-a.sp14.test ...
GET  .../localapi/v0/prefs                                              -> HTTP 200 (readable)
POST .../localapi/v0/logout                                             -> "logout access denied", HTTP 403
```

- tailscaled gives an unprivileged caller read access (whois, prefs) and refuses writes. The only obstacle
  in the container was directory permissions on the path, not the daemon.
- The host-agent unit therefore needs **no extra privilege to ask who is calling**, only a path to a
  socket it can open. On a host install the socket path and its directory mode must be checked by
  `agent install`, not assumed (measured here only on the container image).

### 4. What can pass for a peer

| Attempt (kernel mode `sp14-b`) | Reaches the listener? | whois |
|---|---|---|
| Docker-network neighbour `sp14-x` to `172.19.0.4:18792` (listener on `0.0.0.0`) | yes | `404 no match` |
| `sp14-x` routes `100.64.0.2/32 via 172.19.0.4`, connects to the listener **bound to the tailnet IP** | **yes**, from `172.19.0.7` | `404 no match` |
| `sp14-x` adds `100.64.0.1/32` to its own `eth0` and connects from it (spoofs `sp14-a`) | no, timeout | n/a |
| **A local process on `sp14-b` (uid 1500) connects to `100.64.0.2:18791`** | yes, from `100.64.0.2` | **200: `sp14-b`, `["tag:clawops-agent"]`** |
| Docker-network neighbour to a userspace node's `127.0.0.1` listener | no, `rc=7` refused | n/a |

- **Binding to the tailnet IP does not keep a LAN neighbour out.** Linux accepts a packet for any local
  address on any interface, so a neighbour that routes the tailnet IP to the host's LAN address
  connects. Such a caller has a non-tailnet source and whois answers 404, so **the whois check is
  the boundary, not the bind address**. A firewall rule (ufw: allow the port only on `tailscale0`) is
  the second layer.
- **A spoofed tailnet source is dropped by Tailscale's own netfilter rule**, which counted the packets:
  `-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP` (`10 packets, 600 bytes`). That rule exists in
  the default `--netfilter-mode` (`FirewallMode: ipt-default`). With `--netfilter-mode=off` it would not,
  which was not measured.
- **A process on the host that connects to its own tailnet IP is identified as the host itself, with
  the host's tags.** If peers are allowed by tag and every host agent carries the same tag, any local
  process (the gateway's agents included, if they can reach the host's tailnet IP) passes as a peer.
  The host agent must **refuse a caller whose `Node.StableID` is its own** (from
  `/localapi/v0/status` → `Self.ID`).

### 5. A whois call costs about a millisecond

| Node | `curl` process per call (20 calls) | In-process, keep-alive (20 calls) | Not found (404) |
|---|---|---|---|
| kernel `sp14-b` | median 2.2 ms, max 5.9 ms | median 0.13 ms, max 0.65 ms | ~0.37 s each (3 calls) |
| userspace `sp14-u` | median 5.4 ms, max 19.0 ms | median 0.16 ms, max 7.07 ms | ~0.40–0.53 s |

A whois on every call is affordable. A **miss takes ~0.37 s**, apparently a wait inside tailscaled before it
answers 404. Unauthenticated connections therefore each hold a handler for that long, so the host agent should
bound concurrent unauthenticated lookups.

### Also seen

- **Without a reachable DERP, the first connection to a new peer stalls** until direct discovery
  completes (two `rc=28` timeouts, then success after `tailscale ping`). Real Tailscale has DERP relays, so
  this is a Headscale-setup artefact, but a peer query needs a timeout and one retry.

---

## Consequences for ADR 0015

1. **Tailnet identity works as the peer credential.** The host agent calls LocalAPI whois on the
   connection's remote address for every request and authorises on `Node.Tags`. It holds no token or
   key: tailscaled holds the node key, so R6 is not bent by clawops storing anything.
2. **Authorise on tags, never on `Hostinfo`, names or the user profile.** Names and `Hostinfo` are
   chosen by the peer. Tags are assigned only by whoever controls the tailnet policy (`tagOwners`),
   which is the operator.
3. **Refuse self.** A caller whose `StableID` is the host's own is a local process, and it would
   otherwise carry the shared tag. The rule is required, not optional.
4. **Bind and firewall are defence in depth, not the boundary.** Bind to the tailnet address (kernel
   mode) or loopback (userspace), allow the port only on `tailscale0`, and treat whois 404 as refusal.
   `agent install` should check that tailscaled runs with netfilter on, or record that the spoof drop is absent.
5. **Both networking modes are supported, with different plumbing.** Kernel: listen on the tailnet IP;
   whois by IP. Userspace: listen on loopback; whois needs the exact `127.0.0.1:port` and must run while
   the connection is open. One code path covers both if it always passes the full `ip:port` it accepted.
6. **No privilege needed.** The unit runs whois as an unprivileged user; `agent install` must find a
   socket path that user can open.
7. **Revocation is immediate.** Removing a host's tag cuts it off on its next call. The ADR can make
   "untag the host" the way to drop a peer.
8. **Rate-limit misses.** A 404 costs ~0.4 s. Cap the number of unauthenticated lookups in flight.

## What transfers to real Tailscale, and what is Headscale-specific

- **Should transfer, since it is tailscaled behaviour (same 1.88.3 client):** the LocalAPI whois
  contract, `ip:port` mapping in userspace mode, the read/write split for unprivileged callers,
  `ts-input` spoof dropping, the self-attribution of local connections, and latency.
- **Headscale-specific or unverified on Tailscale SaaS:**
  - On Tailscale, a tagged node's `UserProfile` is the synthetic `tagged-devices` profile rather than
    its creator. Here it was `spike`. That does not change the design (authorise on `Node.Tags`), but a
    check like "the user is the operator" would behave differently.
  - Tag assignment via tagged auth keys and `--advertise-tags` gated by `tagOwners` exists on both, but
    the policy syntax differs (`spike@` here; group or email on Tailscale).
  - Tailscale's ACL `grants` and app capabilities (`CapMap`) were not exercised. `CapMap` was `null`
    here. Tailscale could carry a per-peer capability (e.g. `clawops.dev/cap/peer-read`) in whois, which
    is finer than a tag. Worth a check on a real tailnet.
  - Propagation speed of a retag (2 s here) depends on the control server.
- **Not measured here:** a host (non-container) install's socket path and mode, `--netfilter-mode=off`, and
  nftables firewall mode.
