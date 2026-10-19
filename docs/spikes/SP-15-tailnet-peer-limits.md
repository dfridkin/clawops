# SP-15. Tailnet peer limits: can tags and policy confine who reaches a host agent?

**Status:** COMPLETE. Headscale 2026-10-17; re-checked on real Tailscale 2026-10-18 (see the
last section). The Headscale run: local Docker (Docker Desktop, arm64), no cloud,
no Tailscale account. Control server **Headscale v0.27.1** (`headscale/headscale:0.27.1`);
nodes **Tailscale v1.88.3** (`tailscale/tailscale:v1.88.3`), kernel mode (`--tun=tailscale0`,
`NET_ADMIN`, `/dev/net/tun`), `--state=mem:`. Listeners were busybox `nc -l` on the destination
node; probes were `timeout 5 nc <ip> <port> </dev/null`.

Headscale implements the policy language itself. Every finding about **what the policy permits**
is a Headscale finding; the packet filter that **enforces** it is Tailscale's own
(`tailscaled` on the destination), and so is `whois`. See *Re-checked on real Tailscale*.

Nodes:

| Node | Joined with | Tags | Tailnet IP |
|---|---|---|---|
| `sp15-a` | pre-auth key created with `--tags tag:clawops-agent` | `tag:clawops-agent` (forced) | 100.64.0.1 |
| `sp15-b` | same key; runs the listeners | `tag:clawops-agent` (forced) | 100.64.0.2 |
| `sp15-c` | untagged key of user `admin` (a user device) | none | 100.64.0.3 |
| `sp15-d`, `sp15-e`, `sp15-f` | untagged key, then `--advertise-tags` | see finding 2 | .4, .5, .6 |

---

## 1. A tag-to-tag rule confines the agent port, and enforcement is at the destination

Policy:

```hujson
{
  "tagOwners": { "tag:clawops-agent": ["admin@"] },
  "acls": [
    { "action": "accept", "src": ["tag:clawops-agent"], "dst": ["tag:clawops-agent:18791"] }
  ]
}
```

| Attempt | Result |
|---|---|
| `sp15-a` → `sp15-b:18791` | `ok-18791`, exit 0 |
| `sp15-a` → `sp15-b:8080` (listener running) | timed out, exit 143. `sp15-b` logged `Drop: TCP{100.64.0.1:34953 > 100.64.0.2:8080} 60 no rules matched` |
| `sp15-c` (untagged) → `sp15-b:18791` | timed out, exit 143 |
| `sp15-c` → `sp15-b:8080` | timed out, exit 143 |
| `sp15-c` `tailscale ping 100.64.0.2` | `no matching peer` |

- **Ports are scoped.** A permitted peer reaching a port the rule doesn't name is dropped by the
  *destination's* `tailscaled` packet filter ("no rules matched"). The refusal is a silent drop,
  not a reset, so a client sees a timeout.
- **A device with no rule doesn't even see the agent.** Headscale left `sp15-b` out of `sp15-c`'s
  netmap entirely (`peers []`), so the untagged device had no route, no WireGuard key and no name
  for it.
- **The operator's own devices lose access too.** With only this rule, the operator's laptop
  (an untagged device of `admin`) can't reach any host agent. Admin access needs its own rule, for
  example `{"src": ["admin@"], "dst": ["tag:clawops-agent:22"]}`; finding 4 shows that such a rule
  matches the user's untagged devices and not the tagged agents.

## 2. Who may tag a node is whoever `tagOwners` names, and a refused tag fails silently

| Case | What `tailscale up` returned | Tags afterwards (Headscale `valid_tags` / `tailscale status --json` `Self.Tags`) | Could reach `sp15-b:18791` |
|---|---|---|---|
| (a) untagged `admin` key, `--advertise-tags=tag:clawops-agent`, `admin@` **in** `tagOwners` (`sp15-d`) | exit 0 | `['tag:clawops-agent']` / `['tag:clawops-agent']` | **yes**, `ok-18791` |
| (a) same, `tagOwners` changed to `["ops@"]` and reloaded with SIGHUP (`sp15-e`, new node) | **exit 0, no message** | none / `None` | no, timed out |
| existing `sp15-d` after that reload | n/a | **tag removed** (`valid_tags None`, `Self.Tags None`) | no, timed out |
| existing `sp15-a`, `sp15-b` (forced tags from the key) after that reload | n/a | **kept** `['tag:clawops-agent']` | n/a, still peers of each other |
| (b) `--advertise-tags=tag:other`, a tag not in `tagOwners` at all (`sp15-f`) | exit 0, no message | none / `None` | n/a |
| `headscale preauthkeys create --user 1 --tags tag:other` (a tag nobody owns) | key created | n/a | n/a |

- **Anyone with an untagged key of a user named in `tagOwners` can make a node a peer.** With
  `admin@` owning the tag, `sp15-d` tagged itself and reached the agent port. The tag is only as
  narrow as `tagOwners`.
- **On Headscale, a refused tag isn't an error.** `tailscale up` exits 0 and the node simply joins untagged.
  Anything that installs a peer must read back `Self.Tags`, not trust the exit code.
- **Revoking ownership removes self-advertised tags, not forced ones.** After the reload `sp15-d`
  lost its tag. `sp15-a` and `sp15-b`, tagged by their pre-auth key, kept theirs, even though no
  `tagOwners` entry now allowed `admin` to grant it. When `admin@` was restored, `sp15-d` and
  `sp15-e` got the tag back without any action on the node: Headscale remembers what was
  advertised.
- **The Headscale CLI ignores `tagOwners`.** It minted a pre-auth key for `tag:other`, which no
  one owns. Whoever runs the control server can tag anything.

## 3. A policy change refuses new connections within seconds; an open TCP connection survives it

Setup: policy allowing `tag:clawops-agent` → `tag:clawops-agent:18791,18793`. `sp15-a` held a
stream open to `sp15-b:18791`, writing one numbered line per second; once a second it also tried
a new connection to `sp15-b:18793`. Then the policy was changed to `"acls": []` and Headscale was
sent SIGHUP at `T0 = 1792292832`.

```
t+0s stream_last='15 1792292831' new18793=[ok-18793 0 ]
t+1s stream_last='16 1792292832' new18793=[ok-18793 0 ]
t+3s stream_last='16 1792292832' new18793=[143 ]
t+5s stream_last='18 1792292834' new18793=[143 ]
...
t+41s stream_last='53 1792292870' new18793=[143 ]
```

and, separately, at `T0 + 55 s`: `stream_last='70 1792292887'`.

- **New connections:** refused between 1 and 3 seconds after the reload
  (`Drop: TCP{100.64.0.1:39521 > 100.64.0.2:18793} 60 no rules matched` on `sp15-b`).
- **The established connection kept flowing** for at least 55 seconds after the rule was gone,
  until it was stopped by hand. Tailscale's filter drops new SYNs, but the packets of a TCP
  connection already open were still delivered.
- **Consequence:** revoking a peer stops its *next* connection, not one it holds open. An MCP
  client over streamable HTTP with keep-alive can outlive its revocation.

## 4. A tagged node is identified by its tags; Headscale still reports the user that created it

`tailscale whois 100.64.0.1`, run on `sp15-b`:

```
Machine:
  Name:          sp15-a.sp15.test
  ID:            1
  Addresses:     [100.64.0.1/32 fd7a:115c:a1e0::1/128]
  Tags:          tag:clawops-agent
```

`--json`: `Node.Tags ['tag:clawops-agent']`, `Node.User 1`,
`UserProfile {'ID': 1, 'LoginName': 'admin', 'DisplayName': 'admin'}`. `tailscale status --json`
gives the same `UserID 1` for tagged nodes.

For policy, tags won over user. With the rule `{"src": ["admin@"], "dst": ["tag:clawops-agent:8080"]}`
added:

| Attempt | Result |
|---|---|
| `sp15-c` (untagged `admin` device) → `sp15-b:8080` | `ok-8080` |
| `sp15-a` (tagged by key) → `sp15-b:8080` | timed out, exit 143 |
| `sp15-c` → `sp15-b:18791` | timed out, exit 143 |
| `sp15-d` (tagged by `--advertise-tags`) → `sp15-b:8080` | `ok-8080` |

- **A key-tagged node isn't its user** for policy: `admin@` didn't match `sp15-a`.
- **A Headscale inconsistency:** a node that tagged itself with `--advertise-tags` (`sp15-d`,
  `sp15-e`) matched **both** `tag:clawops-agent` and `admin@`. `sp15-b`'s packet filter listed
  `100.64.0.4/31` in the source set of both rules.
- **For the host agent:** identify a peer by `Node.Tags` from `whois`, never by `UserProfile`.
  Headscale fills `UserProfile` with the creating user even for tagged nodes, so a check on the
  user would accept the operator's laptop and a tagged agent alike.

## 5. With no policy, every node reaches every port

A fresh Headscale (`sp15-hs0`) with no `policy:` block in its config (`headscale policy get`
returns an error: no policy loaded), and two nodes of one user:

- `sp15-y`'s packet filter: `Srcs ['0.0.0.0/0', '::/0']`, `Dsts 0.0.0.0/0 and ::/0, ports 0-65535`,
  protocols TCP, UDP, ICMP, ICMPv6.
- `sp15-x` → `sp15-y:22222`: `ok-y-22222`. The very first attempt timed out, before the
  WireGuard path was up; after a `tailscale ping` it connected.

Tailscale's default policy is also allow-all, so a tailnet nobody has written a policy for lets
every device reach the agent port.

---

## Consequences for ADR 0015

1. **The tailnet's policy is a necessary layer, but not the whole check.** A tag-to-tag rule on the
   agent port keeps untagged devices from reaching it, or even seeing it. But the default policy
   is allow-all (5), and `tagOwners` is as wide as its owners (2). So the host agent must also
   check the caller itself: `whois` the remote address on every request and require one of the
   `--peer` tags in `Node.Tags`.
2. **Never authenticate a peer by user.** `UserProfile` can name the operator for a tagged node
   (4). The check is on tags only, and an untagged caller is refused even if it is the operator's
   own device. The operator's own calls keep coming over SSH, as in ADR 0014.
3. **Install must read tags back.** On Headscale a refused tag returns exit 0 (2); on Tailscale it
   fails with exit 1, but a bare `tailscale up` on a running node still exits 0 with nothing
   changed. `agent install --peer` checks
   `tailscale status --json` `Self.Tags` on the host, and refuses with the reason if the tag isn't
   there.
4. **Prefer tagged auth keys to `--advertise-tags`.** Self-advertised tags come and go with
   `tagOwners` (2). On Headscale they also leave the node matching its user's rules (4).
5. **Revocation needs the agent's help.** A removed rule leaves open connections working (3)
   while the two nodes stay peers. The
   host agent should therefore re-run `whois` per request, not per connection. It should also cap
   how long one HTTP connection may live, so that dropping a tag or rule takes effect within a
   bounded time.
6. **The ADR should state the policy it needs**:
   - tag-to-tag on the agent port only;
   - a separate admin rule for SSH;
   - a `tagOwners` that names only the operator.

   It should also say that a tailnet still on the default allow-all policy makes the tag check
   the only barrier.

## Re-checked on real Tailscale

2026-10-18, on a throwaway tailnet of the project owner's (`tailbdc720.ts.net`), control server
`controlplane.tailscale.com`, the same Tailscale v1.88.3 nodes in local Docker. Policies were set
through the API (`POST /api/v2/tailnet/-/acl`), in the `grants` syntax, and the original
allow-all policy was restored byte-for-byte afterwards. Devices, keys and the API token were
deleted at the end.

| Node | Joined with | Tags |
|---|---|---|
| `sprt-a` (listeners on 7777, 7778), `sprt-b` | reusable key tagged `tag:clawops-agent` | `tag:clawops-agent` |
| `sprt-s3` | reusable key tagged `tag:clawops-spike`, created by the same admin | `tag:clawops-spike` |
| `sprt-u3` | untagged key created through the API (a device of `dfridkin@github`) | none |

Every Headscale finding held except the three marked **differs**.

| Question | Real Tailscale |
|---|---|
| Allow-all default (5) | Holds. Under the default policy every node reached both ports. |
| Tagged-key creation for a tag nobody owns (2) | **Differs.** `POST /keys` with `tags: ["tag:sprt-unowned"]`: `requested tags [tag:sprt-unowned] are invalid or not permitted`. Headscale's CLI minted the key. |
| A tagged key joining with `--advertise-tags` for a tag outside the key (2) | **Differs.** The `tag:clawops-spike` key with `--advertise-tags=tag:clawops-agent`: `backend error: requested tags [tag:clawops-agent] are invalid or not permitted`, **exit 1**, node not joined. Headscale exited 0 and joined untagged. |
| An untagged user key with `--advertise-tags` (2) | Not joined by the key alone. With an unowned tag *and* with a tag the user owns, `tailscale up` printed a login URL and waited for a browser login. A self-tagged node therefore needs the user's interactive login, so it wasn't measured further. |
| `tailscale up --advertise-tags=…` on a running node, no key | Exit 0, no output. The node re-registered and sat in `NeedsLogin`; its tags at the control server were unchanged. |
| `whois` for a tagged node (4) | **Differs.** `UserProfile {LoginName: tagged-devices, ID: 3561806748535406}`, and `Node.User` is the same pseudo-user, for every tagged node. Headscale named the creating user. An untagged node shows its user (`dfridkin@github`). `CapMap` was `None` under plain grants. |
| Do user rules match a tagged node? (4) | No. With `{"src": ["dfridkin@github"], "dst": ["tag:clawops-agent"], "ip": ["tcp:7777"]}`, `sprt-u3` reached `sprt-a:7777`; `sprt-s3`, created with that user's key but tagged, did not. (The self-tagged case is the one not run, see above.) |
| Ports scoped at the destination (1) | Holds. Under tag-to-tag `tcp:7777` plus the user rule: `sprt-b` and `sprt-u3` reached 7777 and not 7778; `sprt-s3` reached neither. |
| Netmap pruning (1) | Holds. `sprt-s3`, with no rule in either direction, had an empty peer list, and neither `sprt-a` nor `sprt-b` listed it. |
| Propagation (3) | A new connection was refused **1.5 s** after the policy `POST` returned 200, and **1 s** in a second run. |
| An open connection after revocation (3) | Depends on whether the peer stays in the netmap. See below. |
| Existing tags when `tagOwners` drops the tag (2) | Key-forced tags kept: all `tag:clawops-spike` nodes still had the tag, at the control server and in `Self.Tags`. The **key** stopped working: a new join failed with `backend error: key tagged with non-existent tag: tag:clawops-spike`, exit 1. |

**Open connections.** Two runs, each with `sprt-s3` streaming one line a second to `sprt-a:7777`
through `nc -e cat`:

- The policy dropped every rule naming `tag:clawops-spike`. The echoes stopped **at the change**
  (last line one second before the `POST`), because `sprt-s3` left `sprt-a`'s netmap and the
  WireGuard peer went with it.
- The policy kept `tag:clawops-spike` → `tag:clawops-agent` on `tcp:7778` and removed 7777. New 7777
  connections were refused within 1 s; the open one was **still echoing 20 s later**. So the
  Headscale finding holds whenever the two nodes remain peers for any reason.

**What this changes for ADR 0015:** nothing in the design. Tags-only authorisation, re-checking on
every request and the connection cap all stand. On Tailscale a refused tag is an error rather than
a silent success, and `UserProfile` can't name the operator for a tagged node. Both make the
Headscale case the stricter one to design for, since a clawops host agent may sit on either.
