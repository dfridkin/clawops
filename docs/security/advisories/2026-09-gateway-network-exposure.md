# Advisory: the gateway port may be reachable from your network

**Applies to:** clawops 1.x (all releases, up to and including 1.7.7)
**Fixed in:** clawops 2.x
**Severity:** moderate — depends on the CIDR you gave the wizard
**Date:** 2026-09-07

## What happens

Two things combine.

**1. The container publishes on every interface.** clawops 1.x runs the gateway with
`-p 18789:18789`, which binds `0.0.0.0` on the host. Whether that port is *reachable* is
then decided entirely by your cloud firewall.

**2. The wizard opens the gateway port to your SSH CIDR.** `clawops setup` writes:

```ts
allowedSshCidrs:     [sshCidr],
allowedGatewayCidrs: [sshCidr],   // the same answer
```

So the CIDR you entered for **shell access** also opened the **gateway** port. If you
answered with an office range, a VPN range, or `0.0.0.0/0`, the gateway is reachable from
all of it.

## What the risk actually is

The gateway is **not** unauthenticated — it requires `OPENCLAW_GATEWAY_TOKEN`, and clawops
generates one. This is not an open door.

The real exposure is:

- **Plaintext HTTP.** There is no TLS. Anyone able to observe traffic on that network can
  read the token and everything the agent sends and receives.
- **The token travels in URLs.** The dashboard link is `http://host:18789?token=…`, so it
  lands in browser history, proxy logs and shoulder-surfing range.
- **Anyone on that network can reach the service** and attack it directly, rather than
  having to get onto the host first.

If you gave a CIDR you actually trust and never open the dashboard over an untrusted link,
the practical risk is low. If you answered `0.0.0.0/0`, treat the token as compromised.

## Check whether you are affected

From a machine **on the CIDR you gave** — not from the host itself:

```bash
curl -sS -m 5 -o /dev/null -w '%{http_code}\n' http://<your-host>:18789/health
```

A response means the port is reachable from that network. A timeout means it is not.

## What to do

**Narrow the firewall rule to nothing and use the tunnel.** The gateway does not need to
be reachable: `clawops tunnel` forwards it over SSH, which is already how the docs
recommend reaching it.

1. Edit your plan so `network.allowedGatewayCidrs` is `[]`.
2. Re-apply: `clawops apply <plan>.json`.
3. Reach the gateway with `clawops tunnel` (Control UI on `http://127.0.0.1:18789`).

If you need direct access from another machine, put a TLS-terminating reverse proxy in
front of it rather than exposing port 18789 itself.

**Rotate the gateway token** if the port was ever open to a network you do not control:

```bash
clawops secret rotate gateway-token   # then: clawops gateway restart
```

## Why this is an advisory and not a patch

clawops 1.x is the maintenance line, and the fix is a behaviour change: deployments that
currently reach the gateway directly would stop working. Changing that under a patch
release would break working setups without warning, which is the opposite of what a
maintenance line is for.

**clawops 2.x fixes it properly:**

- the container publishes on `127.0.0.1` by default, so a permissive firewall rule is no
  longer enough to expose it
- exposure is an explicit choice — `network.publishGateway: "all"` — rather than inherited
  from a CIDR you chose for SSH
- the wizard leaves `allowedGatewayCidrs` empty
- `clawops doctor` warns when the port is on `0.0.0.0`, and `clawops plan` prints the scope

If you would rather have the narrowed wizard default on 1.x as well, open an issue and say
so — it is a small change, and the reason it is not already backported is the behaviour
break, not the effort.
