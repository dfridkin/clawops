# SP-16. Can a host keep its gateway container off a peer's agent port?

**Status:** COMPLETE. 2026-10-17, re-checked 2026-10-18 (findings 6–11). Local Docker only.
- **Outer environment:** Docker Desktop 29.6.2, linux/arm64, kernel 6.12.76-linuxkit.
- **Control server:** Headscale v0.27.1.
- **Peer node:** `tailscale/tailscale:v1.88.3`, kernel mode.
- **Hosts:** the e2e harness's systemd target (`tests/e2e/local/vm/Dockerfile`), built from Ubuntu 24.04.5 and, for Part A only, from Debian 12. Both run privileged with tmpfs `/run` and `/run/lock`, and systemd is PID 1.
  - Tailscale was installed on them the way `src/harden/modules/tailscale.ts` installs it (`curl -fsSL https://tailscale.com/install.sh | sh`). That installed **tailscaled 1.104.1**, the current stable release, not the pinned 1.88.3.
  - Docker on the Ubuntu host is **`docker.io` 29.1.3** from Ubuntu's archive, with containerd 2.2.1. The bootstrap installs Docker CE from Docker's repository instead; both use the same iptables chain layout, but see *What to re-check*.
  - On both hosts, iptables 1.8.x uses the nf_tables backend, and the Docker firewall backend is `iptables`.
  - `/var/lib/docker` and `/var/lib/containerd` were on named volumes, as the harness does it.

**Question for ADR 0015:** a host agent on host A queries peers over the tailnet. On a default deployment, other agents in A's gateway container can run commands. Can they reach a peer's agent port and be identified as host A? If so, is there a rule that drops their traffic while the host agent's own calls pass, and does it survive Docker and tailscaled restarting?

Setup:
- `sp16-host` (Ubuntu, Docker and tailscaled) and `sp16-peer` were both joined with a tagged auth key (`tag:clawops-agent`), under an allow-all policy.
- `sp16-peer` listened on its tailnet address, port 18792, with a busybox `nc -l` loop that logged each caller's address.
- On `sp16-host`, two system users stood in for host processes: `sp16agent` (uid 997) as the host agent, and `sp16other` (uid 996) as anything else.
- `alpine:3.20` containers ran in three placements: the default bridge (which is where the gateway runs, since `src/openclaw/run-flags.ts` passes no `--network`), a user-defined bridge `sp16-udb`, and `--network host`.

A probe artefact to avoid repeating: busybox `nc` without `-w`, given a closed stdin under `timeout`, printed `punt!` and never completed. Every probe below uses `nc -w 4`. The listener serves one connection at a time, so an occasional single timeout on a probe that should pass is the listener still busy. Each such case was re-run.

---

## 1. Containers on either bridge reach a peer, and the peer sees host A

The baseline, with no rules added:

```
container default bridge v4: rc=0 ok-18792
container user bridge   v4: rc=0 ok-18792
container default bridge v6: rc=1
container user bridge   v6: rc=1
container --network host v4: rc=0 ok-18792
host uid sp16agent v4: ok-18792 rc=0
host uid sp16other v4: ok-18792 rc=0
host uid sp16agent v6: ok-18792 rc=0
host uid sp16other v6: ok-18792 rc=0
```

The peer's log for those connections, and its `whois` of the source:

```
connect to [::ffff:100.64.0.2]:18792 from [::ffff:100.64.0.3]:45471
connect to [::ffff:100.64.0.2]:18792 from [::ffff:100.64.0.3]:46453
...
$ tailscale whois 100.64.0.3
  Name:          sp16-host.sp16.test
  Tags:          tag:clawops-agent
```

- **The threat holds.** A container on the default bridge or on a user-defined bridge reaches the peer's port over the tailnet. Docker's `MASQUERADE` rule (`-s 172.17.0.0/16 ! -o docker0`) rewrites the source to the host's tailnet address, so the peer identifies the connection as **host A, with host A's tag**.
- **Bridged containers have no IPv6 path.** Docker's default and user-defined bridges have IPv6 off, and the container had only `::1`, so it can't reach the tailnet's `fd7a:115c:a1e0::/48` addresses. A daemon with IPv6 enabled would need the same rules for v6; that was not measured.
- **Host processes reach the peer over v4 and v6**, whatever their user.

## 2. `DOCKER-USER` never sees this traffic: Tailscale's forward chain accepts it first

The FORWARD chain on a host running both:

```
-A FORWARD -j ts-forward
-A FORWARD -j DOCKER-USER
-A FORWARD -j DOCKER-FORWARD
-A ts-forward -i tailscale0 -j MARK --set-xmark 0x40000/0xff0000
-A ts-forward -m mark --mark 0x40000/0xff0000 -j ACCEPT
-A ts-forward -s 100.64.0.0/10 -o tailscale0 -j DROP
-A ts-forward -o tailscale0 -j ACCEPT
```

With `iptables -I DOCKER-USER 1 -o tailscale0 -p tcp --dport 18792 -j DROP` in place:

```
container default bridge v4: rc=0 ok-18792
container user bridge   v4: rc=0 ok-18792
    0     0 DROP  6  --  *  tailscale0  0.0.0.0/0  0.0.0.0/0  tcp dpt:18792
```

- `ts-forward` ends with `-o tailscale0 -j ACCEPT`, and it runs before `DOCKER-USER`. That ACCEPT ends FORWARD processing, so the rule matched **0 packets**.
- **The chain Docker documents for user rules does not work for tailnet-bound traffic.**

## 3. Two rules together close it: mangle `PREROUTING` for bridges, owner-matched `OUTPUT` for the host

| Rule | Bridged containers | `--network host` container | Host agent uid | Other host uid |
|---|---|---|---|---|
| none | pass | pass | pass | pass |
| `iptables -I FORWARD 1 -o tailscale0 -p tcp --dport 18792 -j DROP` | **blocked** | pass | pass | pass |
| plus `OUTPUT -o tailscale0 -p tcp --dport 18792 -m owner ! --uid-owner 997 -j REJECT` (iptables and ip6tables) | blocked | **blocked** | **pass** (v4 and v6) | **blocked** (v4 and v6) |
| `mangle PREROUTING -i docker0` and `-i br-+`, `-d 100.64.0.0/10` (and the v6 prefix), `--dport 18792 -j DROP`, in place of the FORWARD rule | **blocked** | (OUTPUT rule) blocked | pass | blocked |

Packet counters confirm each rule matched:

```
   8   480 REJECT  6  --  *  tailscale0  0.0.0.0/0  0.0.0.0/0  tcp dpt:18792 ! owner UID match 997 reject-with tcp-reset
   1    80 REJECT  6  --  *  tailscale0  ::/0       ::/0       tcp dpt:18792 ! owner UID match 997 reject-with tcp-reset
  12   720 DROP    6  --  br-+   *  0.0.0.0/0  100.64.0.0/10  tcp dpt:18792
```

- **Bridged traffic is forwarded, not output,** so the owner match can't see it. It needs a rule on the forward path that runs before `ts-forward`'s ACCEPT: either position 1 of `FORWARD`, or mangle `PREROUTING`.
- **A `--network host` container is a host process** to netfilter, so only the `OUTPUT` owner rule stops it.
- **The owner rule trusts the uid.** `docker run --network host --user 997` passed (`ok-18792`). Anyone who can start containers is root on the host anyway, but the rule doesn't add a boundary against them. The same `--user 997` on a bridge was still blocked (`rc=1`), because owner matching doesn't apply to forwarded packets.

## 4. Persistence: Docker's restart wipes `FORWARD`; mangle and `OUTPUT` survive both restarts

After `systemctl restart docker`:

```
-P FORWARD ACCEPT
-A FORWARD -j DOCKER-USER
-A FORWARD -j DOCKER-FORWARD          # the FORWARD rule and ts-forward's jump are both gone
-A OUTPUT -o tailscale0 ... ! --uid-owner 997 -j REJECT      # kept (v4 and v6)
container default bridge v4: rc=0 ok-18792                   # reachable again
```

After `systemctl restart tailscaled`, `ts-forward` is back at position 1, the `FORWARD` rule stays gone, and the `OUTPUT` rules remain.

Repeated with the mangle rules in place of the `FORWARD` rule:

```
## restart docker
-A PREROUTING -d 100.64.0.0/10 -i br-+ -p tcp -m tcp --dport 18792 -j DROP
-A PREROUTING -d 100.64.0.0/10 -i docker0 -p tcp -m tcp --dport 18792 -j DROP
container default bridge v4: rc=1
container user bridge   v4: rc=1
## restart tailscaled
-A PREROUTING -m conntrack ... -j CONNMARK --restore-mark ...   # tailscaled inserts its own first
-A PREROUTING -d 100.64.0.0/10 -i br-+ ... -j DROP
-A PREROUTING -d 100.64.0.0/10 -i docker0 ... -j DROP
container default bridge v4: rc=1
container user bridge   v4: rc=1
```

- **A `FORWARD` rule doesn't survive Docker restarting.** Docker 29 rebuilt `FORWARD` from scratch on restart. That also dropped the jump to `ts-forward`, along with the spoof DROP inside it, until tailscaled restarted.
- **Mangle `PREROUTING` and `OUTPUT` survived both restarts.** Neither Docker nor tailscaled flushes those chains; tailscaled only inserts its own CONNMARK rule above ours.
- **Neither survives a reboot** without something that re-applies it. A oneshot unit ordered `After=docker.service tailscaled.service` would do it; that was not built.

## 5. The gateway does not use host networking

`src/openclaw/run-flags.ts` and `src/openclaw/runtime.ts` pass `--add-host=host.docker.internal:host-gateway` and publish ports, with no `--network`. So the gateway container is on the default bridge, the case the mangle rule covers.

---

## Tailscale's socket on a host install

Measured on Debian 12 and Ubuntu 24.04.5, installed with `install.sh` (tailscaled 1.104.1).

| | Debian 12 | Ubuntu 24.04.5 |
|---|---|---|
| Unit `ExecStart` | `/usr/sbin/tailscaled --state=/var/lib/tailscale/tailscaled.state --socket=/run/tailscale/tailscaled.sock --port=${PORT} $FLAGS` | same |
| `RuntimeDirectoryMode` | `0755` | `0755` |
| Socket | `srw-rw-rw- root root /run/tailscale/tailscaled.sock` | same |
| Path | `/` 0755, `/run` 0755, `/run/tailscale` 0755 | same |
| `/var/run/tailscale/tailscaled.sock` | `/var/run` → `/run` symlink, same file | same |
| Unprivileged `GET /localapi/v0/whois?addr=100.64.0.2:1` | **HTTP 200**, full whois JSON | **HTTP 200** |
| Unprivileged `tailscale whois 100.64.0.2` | `Name: sp16-peer.sp16.test`, `Tags: tag:clawops-agent` | same |
| Unprivileged `POST /localapi/v0/logout` | `logout access denied`, **403** | same |
| Netfilter | `NetfilterMode: 2` (on), `firewallmode="ipt-default"`, "netfilter running in iptables mode v6 = true" | same |
| Spoof drop | `-A ts-input -s 100.64.0.0/10 ! -i tailscale0 -j DROP` present | present |

- **On a host install the socket is reachable as is.** The 0700 directory SP-14 hit was the container image's own `/var/run/tailscale`. On a host install, systemd makes `/run/tailscale` 0755 and the socket is 0666, so a host agent running as a system user can call `whois` with nothing added, and is still refused writes.
- **The netfilter backend is iptables over nf_tables**, and the `ts-input` spoof drop SP-14 relied on is present on both distros by default.
- **`install.sh` left tailscaled enabled but not running** in both containers, until `systemctl start tailscaled`. That matches what `src/harden/modules/tailscale.ts` already handles by starting it if it is down.
- **`install.sh` installs the current stable release** (1.104.1 here), not a version clawops pinned.

---

## Consequences for ADR 0015

1. **§4's firewall layer works, but not with the rule the ADR named.** (Superseded in part by
   findings 8 and 9: write the same two rules as a native nftables table, not with `iptables`.)
   - "Forwarded traffic from Docker bridges is dropped" needs a mangle `PREROUTING` rule (`-i docker0` and `-i br-+`, destination the tailnet prefix, the peer port). `DOCKER-USER` is bypassed by `ts-forward`'s ACCEPT, and a rule at the top of `FORWARD` disappears whenever Docker restarts.
   - Pair it with an `OUTPUT` rule, for iptables and ip6tables, that rejects the peer port on `tailscale0` for every uid but the host agent's. That stops other host processes and `--network host` containers.
2. **Write the rules, check them on every peer query, and re-apply them at boot.** They survive Docker and tailscaled restarts, but not a reboot. The host agent can verify they are present before forwarding a peer query, and refuse the query when they are not, as it re-checks the guardrail.
3. **Keep `--strict` as the first layer.** The rules stop containers on a bridge, but not a process with root or one that can start a container as the agent's uid. Root is already outside every boundary here, so the ADR's statement about root stands.
4. **The peer port must be fixed per fleet** (or per peer, and recorded), because the rules match on it.
5. **IPv6:** the rules need v6 twins. Bridges are v4-only by default, but host processes reached the peer over v6.
6. **The host-socket blocker is closed.** `/run/tailscale/tailscaled.sock` is open to an unprivileged user on Debian 12 and Ubuntu 24.04, reads only. `agent install` should still check the path and mode rather than assume them.

## Re-checked 2026-10-18: Docker CE, nftables, ufw, IPv6 bridges, reboot

Same outer environment, Headscale and peer (now with Headscale's embedded DERP/STUN server, see the
harness note below). The host is the same systemd target with **Docker CE 29.9.1** and
**containerd.io 2.4.2** installed from `download.docker.com` exactly as
`src/providers/local/bootstrap.sh.tmpl` does it, tailscaled 1.104.1 from `install.sh`, ufw set up
with `clawops harden`'s sequence (`ufw --force reset`, deny incoming, allow outgoing, allow 22,
`ufw --force enable`), and the agent uid 999.

### 6. Docker CE behaves like `docker.io`

With the iptables rules from finding 3, the probe table, the `systemctl restart docker` and
`systemctl restart tailscaled` results and the chain order all matched findings 3 and 4 exactly.

### 7. ufw leaves both kinds of rule alone

After harden's sequence, `ufw reload`, a second `ufw --force reset`, `ufw disable` + `enable` and
`systemctl restart ufw`, the mangle `PREROUTING` and `OUTPUT` rules were all still present
(`mangle=2+2 output=1+1`) and still blocking. ufw only rebuilds its own `ufw-*` chains and the
jumps to them. The native table in finding 9 also survived `ufw reload` in all four runs below.

### 8. In tailscaled's nftables mode, the iptables rules can no longer be managed

With `TS_DEBUG_FIREWALL_MODE=nftables` (log: `firewallmode="nft-forced"`), tailscaled writes
native nftables rules into the same `ip mangle PREROUTING` chain iptables-nft uses. From then on:

```
iptables v1.8.10 (nf_tables): chain `PREROUTING' in table `mangle' is incompatible, use 'nft' tool.
```

The rules already there kept dropping (their counters rose), but `iptables -S`, `-C`, `-I` and
`-D` all failed on that chain. A host agent that verifies its rules with `iptables` before each
peer query would refuse every query, and couldn't repair or remove them.

### 9. A native nftables table works in every combination

The rules as one table of clawops's own, which neither Docker, tailscaled nor ufw touches:

```nft
table inet clawops_peer {
  chain pre {
    type filter hook prerouting priority mangle; policy accept;
    iifname { "docker0", "br-*" } ip  daddr 100.64.0.0/10        tcp dport 18792 counter drop
    iifname { "docker0", "br-*" } ip6 daddr fd7a:115c:a1e0::/48 tcp dport 18792 counter drop
  }
  chain out {
    type filter hook output priority filter; policy accept;
    oifname "tailscale0" tcp dport 18792 meta skuid != 999 counter reject with tcp reset
  }
}
```

In nftables every base chain on a hook gives its own verdict, and a `drop` in any of them is
final. So `ts-forward`'s `accept` (finding 2), in another table, can't overrule it, whichever
backend tailscaled and Docker use.

Each combination ran on a **fresh host**, Docker's IPv6 on (`"ipv6": true`, a ULA
`fixed-cidr-v6`, and the user bridge created with `--ipv6`), and the table installed by a oneshot
unit (`After=docker.service tailscaled.service`, `RemainAfterExit=yes`). A probe that failed was
retried twice, so a lone warm-up timeout doesn't count as a block:

| tailscaled / Docker firewall backend | Baseline, no table | Table from the unit | After reboot | After restarting Docker and tailscaled, then `ufw reload` |
|---|---|---|---|---|
| iptables / iptables | everything passes | **only the agent uid passes** (v4 and v6) | same | same |
| iptables / nftables | everything passes | same | same | same |
| nftables / iptables | everything passes | same | same | same |
| nftables / nftables | everything passes | same | same | same |

"Only the agent uid passes" means: blocked for containers on the default and a user-defined
bridge over v4 and v6, for a `--network host` container, and for another uid over v4 and v6.

"Reboot" is `docker restart` of the systemd host. That gives the host a fresh network namespace,
with no netfilter state, and a full systemd boot, so it shows the unit putting the table back
before anything is probed. It doesn't exercise a real kernel's module loading or a cloud image's
boot order.

### 10. With IPv6 on, bridged containers do reach the peer over v6

In every baseline above, both bridges reached the peer at `[fd7a:115c:a1e0::3]:18792` (Docker masquerades ULA
traffic by default), where with IPv6 off they had no route (finding 1). The v6 rule matched and
blocked them in every run.

### 11. Docker's nftables backend needs forwarding turned on first

With `"firewall-backend": "nftables"` and IPv6 on, a fresh host's Docker didn't start:

```
failed to start daemon: Error initializing network controller: error creating default "bridge" network:
IPv6 global forwarding is disabled: check your host's firewalling and set sysctls
net.ipv6.conf.all.forwarding=1 and net.ipv6.conf.default.forwarding=1
```

Docker's iptables backend sets forwarding itself; the nftables one doesn't. That's a property of
Docker's backend, not of these rules. The runs above set the three sysctls in
`/etc/sysctl.d/` for the nftables-Docker hosts.

### Harness notes

- **The first connection after tailscaled restarts can take longer than 4 s.** The agent's probe
  sometimes timed out once and passed on the retry, in every backend. SP-14 saw the same stall
  before a direct path came up. A peer query's timeout has to allow for it.
- **An unreachable placeholder DERP region breaks tailscaled 1.104.1.** Each failed netcheck makes
  it rebind (`last netcheck reported send error. Rebinding.`) about every 3 s, and the WireGuard
  session never settles. Headscale's embedded DERP server, used only for STUN here, fixed it.
- **Restarting Headscale stranded the 1.88.3 peer.** After one failed noise dial it switched to
  `forcing port 443 dial` and never reconnected to `:8080`; the peer had to be rejoined.

## What remains

- **A real VM.** The reboot above was a container restart. Kernel module loading (`nf_tables`,
  `skuid` matching) and a cloud image's boot order are untested.
- **Whether `nft` is installed by default** on the images the bootstrap targets. This host had it
  because the spike installed `nftables`. If it's missing, `agent install` has to install it.
