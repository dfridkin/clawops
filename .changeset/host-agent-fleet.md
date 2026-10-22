---
"@clawops/cli": minor
---

Host agents on several stacks can now read each other over your tailnet (ADR 0015).

- **`clawops agent install --serve-peers <tag>`** makes a host agent answer other host agents on port 18800, on its tailnet address. It needs no token: for each request it asks tailscaled who is calling, and serves the 12 read tools, about this host only, to a node that carries the tag and is not this host.
- **`--peer <stack>=<tailnet name>`** lets a host agent query that peer. It requires `--strict`. A read naming the peer's stack is forwarded, and the answer names the host that gave it. A change naming a peer is refused, with the command for the operator to run, and is recorded on neither host.
- **The firewall table.** Every fleet member gets an nftables table that lets only a dedicated `clawops-peer` user reach peers. Neither the gateway container, nor other containers, nor root can get through, and a unit loads the table again at boot, before Docker. Peer queries are refused while the table is missing.
- **`clawops fleet status`** (and `clawops_stacks_list` with `fleet: true`) reads every stack's host agent, its peers, the firewall table and the tailnet. It reports any peer that can't work, on the host that names it. On a host agent, `clawops_stacks_list` lists this host and its peers, and `fleet: true` gives the fleet view from inside a gateway.
- **`clawops doctor`** warns on a fleet host when the tailnet policy lets nodes without the tag reach the peer port, as the default allow-all policy does.
- **Audit:** the calling host logs which peer a forwarded read went to, and the peer logs the caller's node, ID and tags with every answer and refusal.
