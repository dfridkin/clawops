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

### Part C: the peer listener

The serving side, ADR §2 and §3. A second listener on the tailnet address (kernel mode) or
loopback (userspace mode), port 18800. On every request it runs `whois` on the exact remote
`ip:port`, and refuses a 404, a node without the `--serve-peers` tag, and this host by `StableID`.
It serves only the 12 read tools and caps a connection at 60 s. Only a few missed lookups may be
in flight. ufw allows 18800 only on `tailscale0`. Audit records the caller's name, `StableID`
and tags (§7). Fleet status adds whether the listener is up on each member that serves peers.

### Part D: routing peer queries

The calling side, ADR §4 and §5. A read tool that names a stack in `fleet.peers` is forwarded,
as `clawops-peer`, to that peer's listener. That happens only after the whole guardrail passes,
including `--strict`'s container-reach check, and only while `checkPeerTable` passes on the
kernel's listing. The timeout allows for the first connection after tailscaled restarts, which
took over 4 s in SP-16, and there is one retry. On a host agent, `clawops_stacks_list` lists the
peers and whether each answered, and `fleet: true` answers for this host and its peers instead of
being refused. A destructive call naming a peer is refused with the operator's command, and is
recorded in neither host's `handoffs.jsonl`. No new tool or input.

### Part E: the e2e suite, docs and release

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
