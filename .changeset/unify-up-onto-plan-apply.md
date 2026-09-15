---
'@clawops/cli': patch
---

**`clawops up` could not deploy to a cloud at all.**

There were three implementations of deploying — `clawops up`, `clawops apply`, and the
`clawops_up` MCP tool. The two that were not the plan path each wrote three pieces of stack
config and nothing else:

```ts
await stack.setConfig('region', …)
await stack.setConfig('instanceType', …)
await stack.setConfig('openclawVersion', …)
```

No `sshPublicKey`, so every cloud program refused to run — the same failure that made
plan → apply impossible. No firewall rules, no GCP project pin, no readiness waits, and no flag
for who may connect. The setup wizard builds a plan and applies it, so nothing exercised the
path the README calls the primary command.

`up` and the MCP tool now build a plan and apply it. They gain `--ssh-cidr`, `--gateway-cidr`
and `--publish-gateway`; `--gateway-port` applies to cloud stacks rather than local only; and
`--instance-type` accepts a provider-native machine type, which on Azure is often the only kind
on offer. `--no-wait` returns as soon as the cloud API accepts the resources.

**Azure deploys now pin their subscription.** `azure-native` resolves it from the environment or
the CLI's default, so an `az account set` between the preflight and the apply moved the deploy
to another subscription silently — the hazard `gcp:project` pinning already covered for GCP.

`pnpm test` also refuses to run while the mutation checker has a file mutated, rather than
reporting failures about source nobody wrote.
