# ADR 0015, Host agents read each other over the tailnet

**Status:** Proposed. Waiting on SP-16 and the real-Tailscale re-check (see *Verification*)
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
  tag fails silently, and an open TCP connection outlives its revocation.

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
- **A firewall rule backs it up**, if SP-16 shows one works: forwarded traffic from Docker bridges
  to the tailnet's peer port is dropped, and only the host agent's user may open it from the host.

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
  on Headscale a self-tagged node also matches its user's rules (SP-15 finding 4).
- **The operator's devices need their own rule.** The tag-to-tag rule alone cuts off SSH from the
  operator's laptop (SP-15 finding 1).
- **On the default allow-all policy, the tag check is the only barrier.** `doctor` says so when it
  sees a peer listener on a tailnet whose policy it cannot confirm.

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
  so the operator's own laptop would pass as a peer (SP-15 finding 4).
- **Trusting the tailnet policy alone.** The default policy allows everything and an open connection
  outlives its revocation (SP-15 findings 3 and 5).
- **Tailscale app capabilities (grants) instead of tags.** Finer than a tag, and possibly the better
  credential. Not measured: Headscale returned no `CapMap`. Revisit on a real tailnet.

## Verification

Before this ADR is accepted:

- **SP-16, container egress.** Can a rule on the calling host drop traffic from the gateway
  container to a peer's port over `tailscale0` while the host agent's own calls pass? Measured on a
  systemd target with the real gateway image.
- **The SP-15 re-check list, on real Tailscale.** How `tagOwners` is enforced, existing tags when it
  changes, `whois` for a tagged node (`tagged-devices`), whether user rules match self-tagged nodes,
  netmap pruning and propagation time.
- **A host install's socket.** SP-14 measured the container image. The path and directory mode
  tailscaled uses on Ubuntu, Debian and the local provider's hosts.

When built, e2e tests on the systemd harness, each one breaking one condition alone:

- An untagged caller, a caller with another tag, and the host itself are refused.
- A LAN neighbour reaching the peer port is refused.
- A peer gets reads only; a destructive call naming a peer is refused, records nothing, and
  returns the operator's command.
- A host agent with `--peer` refuses peer queries while another agent can run commands in its
  container.
- Untagging a peer refuses its next request, and a held connection ends within the cap.

## References

- [ADR 0014](0014-host-agent-operator-handoff.md), host agent and handoffs
- [SP-14](../spikes/SP-14-tailnet-caller-identity.md), [SP-15](../spikes/SP-15-tailnet-peer-limits.md)
- [Disclosure review](../security/host-agent-disclosure-review.md), condition 6
- `docs/security/threat-model.md` T11
- WO-34 (Tailscale), WO-57 (OpenClaw Fleet cells, a different thing: tenants on one host)
