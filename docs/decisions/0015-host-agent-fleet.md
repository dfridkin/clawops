# ADR 0015, Host agents read each other over the tailnet

**Status:** Accepted 2026-10-18
**Date:** 2026-10-17
**Deciders:** Project owner
**Revisit:** if Tailscale grants carry an app capability clawops can check in place of a tag, or if
peers need anything other than reads

## Context

[ADR 0014](0014-host-agent-operator-handoff.md) gave each stack a host agent that manages only the
host it runs on. An operator with several stacks has several host agents, and none of them can
answer "how is the rest of my fleet?". ADR 0014 deferred that here, with three constraints:

- **No host holds another host's key.** A fleet manager with every host's SSH key makes one
  chat-reachable gateway the keyholder for the fleet, which is the case T11 describes.
- **Each host agent still manages only itself.** Nothing in a fleet changes what one host agent
  may do to its own host, and nothing lets it act on another.
- **No new tools.** The catalog is at the R1 cap of 30.

The 2026-10-17 decisions: this ADR covers the fleet only (sandboxing other agents, condition 6's
proper fix, gets its own ADR with WO-53), and the fleet is **peer host agents** queried over the
tailnet, authenticated by tailnet identity rather than by a token.

Two spikes measured what tailnet identity can carry, on Headscale 0.27.1 with Tailscale 1.88.3
nodes, in local Docker:

- **[SP-14](../spikes/SP-14-tailnet-caller-identity.md): the caller can be identified.** A LocalAPI
  `whois` on the connection's remote address returns the calling node and its `Tags`. It works in
  kernel and userspace networking, an unprivileged process can ask, and it fails closed. Three
  things can pass for a peer unless refused: a LAN neighbour reaching the port (whois says 404), a
  process on the host itself (whois names the host, with its tags), and a spoofed tailnet source
  (dropped by Tailscale's own netfilter rule).
- **[SP-15](../spikes/SP-15-tailnet-peer-limits.md): policy narrows who reaches the port, but is not
  the check.** A tag-to-tag rule confines the agent port, and untagged devices do not even see the
  host. But the default policy allows everything, a tag is only as narrow as `tagOwners`, a refused
  tag fails silently on Headscale, and an open TCP connection outlives its revocation while the two
  nodes stay peers. Re-checked on real Tailscale, which is stricter on two points: it refuses an
  unowned tag with an error, and `whois` reports a tagged node as the `tagged-devices` pseudo-user.

Combining them shows one more case. On a default deployment every other agent in host A's gateway
container can run commands (condition 6). A connection one of them opens to host B leaves host A
over its tailnet address, so **B identifies it as host A, tag and all**. Tailnet identity names a
host, not a process on it.

## Decision

### 1. A peer is a host agent the operator named, reached by tag

Two opt-ins, both at `agent install`, both off by default:

```
clawops agent install --stack eu ... --serve-peers tag:clawops-agent     # eu answers peers
clawops agent install --stack us ... --peer eu=eu-gw                     # us may query eu
```

- **`--serve-peers <tag>`** opens a second listener on the host's tailnet address (kernel mode) or
  loopback (userspace mode), on its own port. It serves only peer reads (§3). The existing listener
  on the Docker bridge, for the host's own gateway, is unchanged and keeps its token.
- **`--peer <stack>=<tailnet name>`** records a peer in the host agent's configuration. The list
  is explicit: a host agent queries no node it was not given, whatever the tailnet offers.
- Install checks that tailscaled runs and that the host carries the tag, by reading back
  `tailscale status --json` `Self.Tags`. A refused tag exits 0 and leaves the node untagged
  (SP-15 finding 2), so the exit code proves nothing. It refuses with the reason when the tag is
  absent.
- The host agent asks tailscaled at `/run/tailscale/tailscaled.sock`, as its own unprivileged
  user. On Debian 12 and Ubuntu 24.04 the socket is 0666 in 0755 directories, and tailscaled
  answers `whois` from any user while refusing writes (SP-14 finding 3, SP-16). Install checks the
  agent's user can reach it.

### 2. Every request is checked against the caller's tailnet identity

On every request, not every connection, the peer listener asks tailscaled `whois` for the exact
`ip:port` it accepted, while the connection is open. It answers only when:

- **whois finds a tailnet node.** A 404 is a refusal (SP-14 finding 4).
- **The node carries a tag named in `--serve-peers`.** Tags only: `Hostinfo` and names are chosen
  by the peer, and Headscale reports the creating user even for tagged nodes, so a check on user
  would accept the operator's laptop and a tagged agent alike (SP-15 finding 4).
- **The node is not this host.** A local process connecting to the host's own tailnet address is
  identified as the host, with its tags (SP-14 finding 4). Compared on `StableID`.

Around that check:

- **A connection lives at most 60 seconds.** A revoked peer keeps an open TCP connection working
  (SP-15 finding 3). Re-checking per request covers keep-alive. The cap bounds a request that is
  already running.
- **Lookups that miss are bounded.** A miss takes about 0.4 s inside tailscaled (SP-14 finding 5).
  A small number in flight, refused beyond that.
- **The bind address and firewall are defence in depth.** ufw allows the peer port only on
  `tailscale0`. The whois check is the boundary, because Linux accepts a packet for the tailnet
  address on any interface (SP-14 finding 4).

### 3. Peers can only read

- **The peer set is the host agent's read set**, the 12 tools of ADR 0014 §1. Nothing destructive
  is offered to a peer, whatever `--allow` says for the host's own agent.
- **A destructive call naming a peer is refused on the calling side** with the command for the
  operator to run (`clawops gateway restart --stack eu`). Nothing is recorded in either host's
  `handoffs.jsonl`: a request belongs to the host whose own agent made it, and the operator's
  `status` for the peer must not show requests another host's agent made up.
- **Answers are whole.** The disclosure review kept the read set complete because only the operator
  reaches a host agent. A peer passes that on (§4), so the peer gets what the host's own agent gets.

### 4. A host may query peers only while no other agent can act in its container

The case found by combining the spikes is closed on the calling side:

- **`--peer` requires `--strict`.** A host agent with peers refuses every peer query while
  `containerReach` reports any other agent that can run commands, read or write files, or change
  the gateway configuration in the gateway container. That is ADR 0014's condition 6, made a
  refusal instead of a report. It is checked on every call, like the rest of the guardrail.
- **The operator-only guardrail must pass first.** A peer query is a tool call, so the host agent
  checks its whole guardrail before forwarding it. The peer cannot see that check; it relies on
  the operator having installed every tagged host this way.
- **Firewall rules back it up** ([SP-16](../spikes/SP-16-container-egress.md)). The obvious rule,
  in `DOCKER-USER`, matched nothing: Tailscale's `ts-forward` chain accepts traffic leaving on
  `tailscale0` before Docker's chain runs. Two rules together close it, as one nftables table of
  clawops's own (`inet clawops_peer`), so each covers IPv4 and IPv6:
  - a `prerouting` chain at mangle priority drops traffic from `docker0` and `br-*` to the tailnet
    prefixes on the peer port, which covers the default bridge the gateway runs on and
    user-defined bridges;
  - an `output` chain rejects the peer port on `tailscale0` for every uid but the host agent's
    (`meta skuid`), which covers other host processes and `--network host` containers.

  A table of its own, not `iptables` rules, because tailscaled in nftables mode writes native rules
  into iptables-nft's `mangle PREROUTING`, after which `iptables` can no longer list or change that
  chain (SP-16 finding 8). In a separate table a `drop` is final whatever any other table accepts,
  and Docker, tailscaled and ufw leave it alone. It held on all four combinations of iptables and
  nftables backends for Docker CE and tailscaled, with IPv6 bridges, across restarts of Docker,
  tailscaled and ufw (SP-16 findings 6–10), and after a real reboot of Ubuntu 22.04 and Debian 12
  VMs (finding 12). Nothing persists it across a reboot, so a oneshot unit applies it at boot,
  ordered `Before=docker.service tailscaled.service`: Docker starts the containers it restarts as
  soon as it is up, and the table matches interfaces by name, so it doesn't need them to exist yet.
  Each `pre` rule names one interface pattern, because nft 1.0.2 on Ubuntu 22.04 rejects a
  wildcard inside a set. `agent install` installs `nftables`, which Debian 12's cloud image lacks. **The host agent checks it is present before every peer query
  and refuses when it is not.** The peer port is fixed, so the rules can name it. A container
  started as the agent's uid with `--network host` passes the owner rule, but starting containers
  already needs root. A peer query's timeout allows for the first connection after tailscaled
  restarts, which took over 4 s in SP-16.

  *Implementation note, WO-67 part A (2026-10-18):* the peer port is 18800, and the owner rule lets
  through a dedicated `clawops-peer` user rather than the host agent's uid. The host agent runs
  as root, as every `--network host` container does, so a rule naming root would let those
  through. Peer queries run as `clawops-peer` ([fleet plan](../fleet-plan.md)).

  *Implementation note, pre-2.5 review (2026-10-29):* refusing peer queries while the table is
  missing protects only the host agent's own queries. A leaf needs no `--strict`, so there the
  table is the only barrier, and a container that connects itself is not refused by anything.
  The host agent therefore reads the table back every 30 s and restores it when it is missing or
  changed, auditing each repair, and `doctor` fails while it is not the one install loaded.
  Making Docker require the unit was rejected: it covers only a failed boot load, not a flush
  while running, and turns that into an outage of every container on the host. What remains is a
  window of up to one check, and the boot case when the unit's load fails (docs/limitations.md).

This leaves the case where root on a tagged host is compromised. Root can query every peer as that
host, which is no more than root can already read through the host's own agent. It cannot change a
peer.

### 5. Tools route by stack name

- **The read tools already take a stack name.** A host agent refuses any name but its own today.
  A name in its peer list is forwarded to that peer's listener instead; the result says which host
  answered.
- **`clawops_stacks_list` lists the peers**, and whether each one answered.
- **No new tool and no new input.** The catalog stays at 30.
- **An unreachable peer is a note, not a failure.** A peer query has a timeout and one retry
  (SP-14 saw first connections stall before a direct path came up).

*Implementation note, WO-67 part D (2026-10-21):*
- **Finding the peer.** A peer is found in tailscaled's own peer list by its MagicDNS name, not
  through DNS. A short name two nodes share is refused.
- **One hop.** A peer answers `clawops_stacks_list` for itself only, so `fleet: true` on a host
  agent never reaches a peer's peers.
- **Timeouts.** Each attempt has 7 s ([fleet plan](../fleet-plan.md)).

### 6. The tailnet policy clawops documents

The operator owns the tailnet's policy; clawops never edits it. The docs give the policy this
design assumes:

```hujson
{
  "tagOwners": { "tag:clawops-agent": ["<operator>"] },
  "acls": [
    { "action": "accept", "src": ["tag:clawops-agent"], "dst": ["tag:clawops-agent:<peer port>"] },
    { "action": "accept", "src": ["<operator>"], "dst": ["tag:clawops-agent:22"] }
  ]
}
```

- **`tagOwners` names only the operator.** A tag is as narrow as its owners (SP-15 finding 2).
- **Tagged auth keys, not `--advertise-tags`.** Advertised tags come and go with `tagOwners`, and
  on Headscale a self-tagged node also matches its user's rules (SP-15 finding 4). On Tailscale a
  key can't self-tag a node at all; `--advertise-tags` with an untagged key waits for a browser
  login. Dropping a tag from `tagOwners` keeps it on existing nodes but stops its keys joining new
  ones, so removing a host from the fleet means untagging or deleting its node.
- **The operator's devices need their own rule.** The tag-to-tag rule alone cuts off SSH from the
  operator's laptop (SP-15 finding 1).
- **On the default allow-all policy, the tag check is the only barrier.** `doctor` says so when it
  sees a peer listener on a tailnet whose policy it cannot confirm.

*Implementation note, WO-67 part E (2026-10-22):* `doctor` reads more than this expected. tailscaled
serves the packet filter compiled for the node, so on a host that serves peers doctor reports what
can reach the peer port. It warns on every node, as on allow-all, or on named untagged nodes, and
also when the filter can't be read.

### 7. Audit on both sides

The calling host agent logs the forwarded call with the peer's name. The peer logs the caller's
node name, `StableID` and tags with every answer, and every refusal with its reason (R21).

## R-meta-3: the rules this bends

**R6, credentials never in clawops config or tool args.**
- *How it is bent:* it is not, in the letter: clawops stores no token or key for a peer. tailscaled
  holds the node key, and the host agent asks it who is calling.
- *What changes:* the node key becomes a fleet credential. Anything that can use it, meaning root
  on a tagged host or a process that reaches the host's tailnet address from the host's own
  network namespace, reads every peer.
- *Mitigation:* §2 refuses the host itself, §4 refuses peer queries while any other agent can run
  commands in the container, and peers can only read (§3).
- *Revisit:* if Tailscale's grants let a capability name the host agent's process rather than the
  host.

**T11, the gateway's AI as a deputy.** The blast radius of one injected host agent grows from its
own host's records to every peer's. It still cannot change anything, on its host or any other.

## Consequences

**Positive:**
- An operator can ask one host agent about every stack they own, from the chat they already use.
- No host holds another's key, no token is shared, and there is no new service or tool.
- Revoking a peer is untagging it in the tailnet. That takes effect on its next request (SP-14
  finding 1, SP-15 finding 3).

**Negative:**
- Every host must be on a tailnet, and the operator must write its policy. A stack that is not is
  refused as a peer, with the reason.
- `--strict` becomes a requirement for a host that queries peers, so on most deployments the
  operator must first restrict the gateway's other agents.
- A compromised root on one tagged host reads every peer.
- The design rests on control-plane behaviour measured on Headscale. Tailscale's must be confirmed
  before this is accepted.

**Neutral:**
- A host that serves peers but has no `--peer` list of its own is a leaf. The fleet need not be
  symmetric.

## Alternatives Considered

- **Operator-side fleet view only** (#182). The operator's clawops already has SSH to every host,
  so a multi-stack `status` adds no trust. Set aside as the *only* answer because it gives no fleet
  view from inside a gateway. It is still worth building, and it is independent of this ADR.
- **A shared bearer token between peers.** Simple, and exactly the shared key ADR 0014 ruled out:
  every host could then act as every other, forever, until rotated by hand.
- **One fleet manager holding every host's SSH key.** The T11 case. Rejected in ADR 0014.
- **Authorising peers by tailnet user.** Headscale reports the creating user even for tagged nodes,
  so the operator's own laptop would pass as a peer (SP-15 finding 4). Tailscale reports
  `tagged-devices` instead, but a check that is safe on only one control server isn't safe.
- **Trusting the tailnet policy alone.** The default policy allows everything and an open connection
  outlives its revocation (SP-15 findings 3 and 5).
- **Tailscale app capabilities (grants) instead of tags.** Finer than a tag, and possibly the better
  credential. Not measured: neither Headscale nor Tailscale under plain grants returned a `CapMap`,
  and an app-capability grant wasn't tried. Revisit.

## Verification

Before this ADR is accepted:

- ~~A reboot on a real VM.~~ Done 2026-10-18 on AWS, Ubuntu 22.04 and Debian 12 (SP-16 finding 12).
  It changed three details in §4 and nothing in the design: the rule form, installing `nftables`,
  and ordering the unit before Docker.
- ~~The SP-15 re-check list, on real Tailscale.~~ Done 2026-10-18 (SP-15, *Re-checked on real
  Tailscale*). No change to the design. Not run: a node that tags itself with `--advertise-tags`,
  which needs an interactive login.

When built, e2e tests on the systemd harness, each one breaking one condition alone. Done
2026-10-22 in `pnpm test:e2e:fleet` (WO-67 part E), with every case below passing:

- An untagged caller, a caller with another tag, and the host itself are refused.
- A LAN neighbour reaching the peer port is refused.
- A peer gets reads only; a destructive call naming a peer is refused, records nothing, and
  returns the operator's command.
- A host agent with `--peer` refuses peer queries while another agent can run commands in its
  container.
- Untagging a peer refuses its next request, and a held connection ends within the cap.
- After a reboot, a gateway container with a restart policy can't reach a peer at any point, and
  the host agent refuses peer queries while the table is missing.

## References

- [ADR 0014](0014-host-agent-operator-handoff.md), host agent and handoffs
- [SP-14](../spikes/SP-14-tailnet-caller-identity.md), [SP-15](../spikes/SP-15-tailnet-peer-limits.md), [SP-16](../spikes/SP-16-container-egress.md)
- [Disclosure review](../security/host-agent-disclosure-review.md), condition 6
- `docs/security/threat-model.md` T11
- WO-34 (Tailscale), WO-57 (OpenClaw Fleet cells, a different thing: tenants on one host)
