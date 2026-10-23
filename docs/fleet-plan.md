# The host-agent fleet, 2.5: WO-67

[ADR 0015](decisions/0015-host-agent-fleet.md) (accepted 2026-10-18) lets host agents read each
other over the tailnet. Each one still manages only its own host. This is the work order that
builds it.

**WO-67. Peer host agents over the tailnet** *(L, five parts, one PR each)*

2.5 is cut only when all five are done. Until then the fleet flags exist on `main` but don't
produce a working fleet, so no part adds a changeset; part E adds one for the whole feature.

### Part A: fleet membership and the firewall table ✅

`agent install --serve-peers <tag>` and `--peer <stack>=<tailnet name>` make a host a fleet
member. On a fleet member, install:

- refuses `--peer` without `--strict` (ADR §4), a malformed tag or peer, this stack as its own
  peer, and a stack named twice;
- reads `tailscale status --json` before writing anything, and refuses unless the node is
  `Running` and, for `--serve-peers`, carries the tag. It reads the tags back because a refused tag
  can leave `tailscale up` exiting 0 (SP-15 finding 2);
- installs `nftables` where it's missing (Debian 12's cloud image), creates the `clawops-peer`
  system user, and loads the table `inet clawops_peer` (SP-16 findings 9 and 12) before the agent
  starts. A oneshot unit, `clawops-peer-fw.service`, ordered `Before=docker.service
  tailscaled.service`, loads it again at every boot;
- reads the table back from the kernel and refuses unless it is exactly what install wrote;
- records `fleet: { serves, peers, peerUid }` in `agent.json`.

`agent uninstall` removes the table, its unit and files, and the user.

Every fleet member gets the table, not only hosts with `--peer`. A leaf that only serves peers is
still tagged, so its containers could query the other peers as the leaf.

**Two details the ADR left open:**
- **The peer port is 18800**, fixed so every host's rules can name it.
- **Peer queries run as `clawops-peer`, not as the host agent.** The ADR's owner rule lets "the
  host agent's uid" through, but the host agent runs as root (ADR 0014's install), and so does
  every `--network host` container. A rule that let root through would let them through too. Part
  D runs each peer query in a child process with that user's uid. The same goes for the ADR's
  check that the agent's user can reach tailscaled's socket: root always can, so only
  `clawops-peer` needs checking, and part C does that.

Accepted by `tests/hostagent/peer-firewall.test.ts` and `tests/hostagent/install.test.ts` (each
mutation-checked), and by `tests/e2e/local/peer-firewall.e2e.test.ts` on the systemd target. That
test covers nftables installed where the image lacks it, this kernel's `nft list` matching the
check, the table back after a restart with a new PID 1 and loaded before `docker.service` started,
a second install leaving one table, a rule inserted ahead of the drops failing the check, and a
clean removal.

### Part B: fleet status ✅

`clawops fleet status`, and `clawops_stacks_list` with `fleet: true`, list every stack's host
agent from the operator's machine. Both call `src/hostagent/fleet-status.ts`. It reads each host
over SSH in one script, as root, four hosts at a time with 30 s each. Per host it reports:

- whether a host agent is installed and its service runs;
- which OpenClaw agent it serves, and whether it was installed with `--strict`;
- on a fleet member, the tag it serves, its peers, whether the firewall table passes
  `checkPeerTable`, whether `clawops-peer-fw.service` is enabled, and the tailnet state, name and
  tags.

Then it checks hosts against each other, reporting on the caller:
- a peer with no host agent;
- a peer installed without `--serve-peers`;
- a peer whose tag the caller does not carry;
- a peer reached by a name it does not have on the tailnet.

A peer outside the config, or one that did not answer, is not judged; one that is not deployed is
reported. A stack with nothing deployed is listed as such, not as unreachable. The command exits 1
on any problem or unreachable host.

It is an input on an existing tool, not a new tool: the catalogue is at R1's cap of 30.
`clawops_stacks_list` now sets `openWorldHint: true`, since with `fleet: true` it reaches hosts.
The answer stays within R14's 8 KB: a large fleet loses the detail of healthy hosts first, never
the problems. A host agent refuses `fleet: true` for now, because it reads only its own host.
Part D decides what it reports about its peers.

Accepted by `tests/hostagent/fleet-status.test.ts` (each check mutation-checked) and by the fleet
status test in `tests/e2e/local/peer-firewall.e2e.test.ts`, which reads a real systemd and nft.
That test found a bug the fakes had hidden: agent.json ends without a newline, so the next
section's marker ran onto its last line.

### Part C: the peer listener ✅

The serving side, ADR §2 and §3, in `src/hostagent/peer-listener.ts`, with tailscaled's LocalAPI
in `tailscaled.ts`. A host agent whose agent.json has `fleet.serves` starts a second listener on
port 18800:
- **Where it binds.** In kernel mode it binds the node's tailnet addresses, v4 and v6. In
  userspace mode (`TUN: false` in status) it binds loopback.
- **When it binds.** At boot it waits for tailscaled to be `Running` with an address. It never
  stops the host's own listener.

On every request it:
- asks tailscaled `whois` for the exact remote `ip:port`, and `status` for this host's `StableID`;
- refuses 403 for a 404 (not a tailnet node), for this host by `StableID`, and for a node without
  the tag;
- refuses 503 when either answer can't be read.

Around that check:
- **Lookups.** At most 4 caller lookups are in flight, and any more are refused.
- **Requests.** A connection lasts at most 60 s, and only POST is answered.
- **Statelessness.** Each request gets a stateless MCP server of its own, holding the 12 read
  tools and nothing else. A read naming another stack is refused.
- **No guardrail on this host.** The host's operator guardrail is not checked on a peer's call.
  It is about who reaches this host's own agent, and the caller checked its own guardrail first.
- **Audit.** Every answer records the caller's name, `StableID` and tags (§7). So does every
  refusal, with its reason. A refusal before any tool ran is logged as `peer_listener`.

Install also changes:
- **ufw.** Where ufw is active, a host that serves peers allows 18800 on `tailscale0` only.
  Uninstall removes the rule, and `harden`'s ufw reset adds it back.
- **The unit.** A fleet member's unit is ordered `After=tailscaled.service`.
- **The socket check.** Install checks that `clawops-peer` can run `tailscale status`, and refuses
  if not. Part D's queries run as that user and ask tailscaled where a peer is, so they don't
  depend on MagicDNS.

Fleet status reads `ss -Htln` on port 18800. It reports a member that serves peers, whose service
runs and that has nothing listening.

Accepted by `tests/hostagent/peer-listener.test.ts`. That suite runs a real HTTP listener and MCP
client on loopback, with tailscaled faked per test. It also needs `tailscaled.test.ts` (a real
unix socket), and new cases in `install.test.ts` and `fleet-status.test.ts`. Each was
mutation-checked.

**Measured 2026-10-21** with the built host agent, on Headscale 0.27.1 and Tailscale 1.88.3 in
local Docker:
- **Bind addresses.** A userspace node and a kernel node bound loopback and both tailnet
  addresses respectively, from real `TUN` and `TailscaleIPs`.
- **The tagged peer** got 12 tools and an answer, over v4 and v6. `clawops_gateway_restart` was
  "not found", though the host's own agent was allowed it.
- **Refused callers.** These were refused with the reasons above:
  - an untagged node;
  - a `tag:other` node;
  - the host itself;
  - a LAN neighbour routing the tailnet address over Docker's network. Linux accepted its packet,
    as SP-14 found, and whois said 404.
- **Userspace callers.** These arrived from `127.0.0.1:<port>`, and whois told them apart by port.
- **Revocation.** Retagging the peer refused its next request, and restoring the tag let it back.
- **Cold paths.** As in SP-14, the first connection to a node without a direct path timed out, on
  a tailnet with no DERP. That is part D's timeout and retry.
- **`ss`.** Its output on the e2e target matches what fleet status parses.

### Part D: routing peer queries ✅

The calling side, ADR §4 and §5, in `src/hostagent/peer-route.ts` and `peer-client.ts`.

**What is forwarded.** `hostAgentDispatch` checks the guardrail first, then whether the call's
`stackName` is in `fleet.peers`. If it is, a read tool goes to that peer and anything else is
refused. Before any peer query:
- the host agent must have been installed with `--strict`, checked again in case agent.json was
  edited;
- `checkPeerTable` must pass on the kernel's listing of the table.

**Destructive calls.** A handoff tool naming a peer is refused with the operator's command, built
by `buildHandoff` and never recorded. Any other tool naming a peer is refused with no command.

**How a query is sent.** It runs in a child process: the same build, `host-agent.mjs
--peer-call`, spawned with clawops-peer's uid and gid from `/etc/passwd`. The child gets only
`PATH` and the tailscaled socket path, and its working directory is `/`. It finds the peer by
`--peer` name, full or first label, in tailscaled's `status` peer list. That list is keyed on the
control server's DNS name, never the peer's own HostName. The child:
- refuses a short name two nodes share;
- prefers the peer's IPv4 address;
- POSTs one `tools/call`.

**Limits.** Each attempt has a 7 s deadline on the whole exchange, so a peer can't keep a query
alive by dripping bytes. A failed or stalled connection gets one retry; an answer, even a
refusal, is never retried. The child is killed after 19 s. Forwarded answers start "Answered by
peer eu (eu-gw.…)" and are capped at 8 KB. The audit line gets `forwardedTo`.

**`clawops_stacks_list` on a host agent.**
- It lists this host and each peer, and says whether each one answered.
- `fleet: true` reads this host with the status script, run locally as root.
- It asks each peer for `fleet: true`. The peer listener's own stacks list answers `{ host }` for
  itself alone and never forwards, so a fleet query is one hop.
- It runs `crossCheck` over the result.
- A peer's account of itself is data. One with another stack name, an unknown state, or no host
  is reported as such.

Accepted by:
- `tests/hostagent/peer-route.test.ts`, through a real MCP server and client, with the peer
  faked and every call it would receive recorded;
- `tests/hostagent/peer-client.test.ts`, including a real child process spawned with this user's
  own uid;
- `tailscaled.test.ts`.

Each was mutation-checked, 26 mutations.

**Measured 2026-10-21** on Headscale 0.27.1 and Tailscale 1.88.3 in local Docker. The caller was
a kernel-mode node, and its host agent ran as root beside a real `clawops-peer` and the real
`inet clawops_peer` table:
- **Without the table:** root reached the peer's port, and every peer query was refused.
- **With the table:** root's connection to the peer's port was blocked, and clawops-peer's got
  through.
- **Forwarding:** a forwarded `config_get` came back from the peer through the child process,
  attributed to it. `fleet: true` listed both hosts as each read itself, and a peer name not on
  the tailnet as unreachable.
- **Write calls:** `gateway restart --stack <peer>` was refused with the command.
- **Audit:** the caller's log had `forwardedTo` and the peer's had the caller. Neither host had a
  `handoffs.jsonl`.
- **Losing the table:** deleting it refused the next query.

### Part E: the e2e suite, docs and release ✅

ADR 0015's e2e list, on the systemd harness with Headscale. Each test breaks one condition
alone:
- an untagged caller, a caller with another tag, and the host itself;
- a LAN neighbour;
- reads only, and a destructive call to a peer refused with nothing recorded;
- `--peer` refused while another agent can act in the container;
- untagging a peer, and a held connection ending within the cap;
- after a reboot, a gateway container with a restart policy never reaching a peer, and peer
  queries refused while the table is missing.

The rest of the part:
- the tailnet policy in the docs (§6), and the `doctor` note for a peer listener on an
  allow-all policy;
- the site: `operations.mdx`, `commands.mdx` (including `fleet status`), `security.mdx`, `limitations.mdx`;
- `docs/security/tool-risk-matrix.md` and `mcp-safety.md`, for what a peer can reach;
- a changeset for the whole fleet.
- at release, the clawops.fyi banner (#222) changes from "Coming in 2.5" to live, and links the
  fleet docs instead of the ADR. It merges at the same time as the Version Packages PR, with the
  owner's OK.

**What was built and measured** (`pnpm test:e2e:fleet`, 13 tests, in the e2e workflow's `fleet` job):
- **The suite.** Headscale 0.27.1 with its embedded DERP relay, two systemd targets with OpenClaw from `clawops up`, Tailscale
  1.88.3 installed as its package does, and real `agent install --strict --serve-peers` (and
  `--peer` on one). Callers that are not fleet hosts: an untagged node, a `tag:other` node and a
  LAN neighbour. Every case on ADR 0015's list passes, each breaking one condition. The policy is
  allow-all until the last test, so each refusal is the host agent's own.
- **The uid drop under the unit's sandbox** works: `NoNewPrivileges` and `ProtectSystem=strict`
  leave the child able to become `clawops-peer`, read tailscaled and reach the peer.
- **The reboot.** Two containers with `--restart always`, one on Docker's bridge and one on the
  host network as root, tried the peer every 250 ms through a reboot, and never connected.
  `clawops-peer` reached the peer again within seconds of the boot.
- **The documented policy (§6)** keeps an untagged node off port 18800 altogether, and the fleet
  works under it.
- **`doctor`'s policy check.** The ADR said doctor would note a policy "it cannot confirm". It can
  read more than that: tailscaled serves the packet filter the control server compiled for the
  node, at `/localapi/v0/debug-packet-filter-rules`. On allow-all that is one rule from
  `0.0.0.0/0` and `::/0` to every port. Doctor now reports what can reach port 18800: every node,
  the untagged nodes it can, only tagged ones (pass), or none.

**Found on the way:**
- **Two OpenClaw hosts don't fit a laptop.** About 10 GB of images; Docker Desktop stopped on a
  Mac with 13 GB free. The suite has its own opt-in and its own CI job, which frees runner disk.
- **Without a relay, a first handshake outlasts a peer query.** The suite's tailnet first had no
  DERP relay. Disco pings answered within milliseconds, but the first WireGuard handshake
  between two nodes took 15 s to more than 90 s, so a host's first query to a peer came back
  unreachable. With Headscale's embedded relay, served over TLS with a per-run certificate, every
  first contact took 114-144 ms and every test passed. A tailnet with no relay is a choice only a
  self-hosted control server allows; `docs/limitations.md` says what it costs.
