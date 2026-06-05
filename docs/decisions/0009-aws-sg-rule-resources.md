# ADR 0009 — AWS SecurityGroup: migrate from inline rules to SecurityGroupIngressRule/EgressRule

**Date:** 2026-06-04  
**Status:** Accepted  
**Rule violated:** R-meta-3 (ADR required for spec or design-rule deviations)

---

## Context

The original `aws/program.ts` used `aws.ec2.SecurityGroup` with inline `ingress` and `egress` arrays:

```typescript
const sg = new aws.ec2.SecurityGroup('clawops-sg', {
  vpcId: vpc.id,
  ingress: [...sshIngressCidrs.map(...), ...gatewayIngressCidrs.map(...)],
  egress: [{ protocol: '-1', fromPort: 0, toPort: 0, cidrBlocks: ['0.0.0.0/0'] }],
})
```

Pulumi's AWS provider documentation explicitly warns against inline ingress/egress arrays when a Security Group manages multiple CIDR blocks:

> "Avoid using the ingress and egress arguments of the aws.ec2.SecurityGroup resource to configure in-line rules, as they struggle with managing multiple CIDR blocks."

The recommended replacements are `aws.vpc.SecurityGroupIngressRule` and `aws.vpc.SecurityGroupEgressRule` (one resource per CIDR per port).

## Problem

When a user updates `allowedCidrs` on an existing stack (a routine day-2 operation — e.g. their office IP changes), Pulumi must replace the entire Security Group because the inline arrays changed. During the replacement window:

1. Old SG is dissociated from the EC2 instance.
2. New SG is created and associated.
3. Both steps require API round-trips; during the gap the instance has no SG and **all inbound SSH and gateway traffic is blocked**.

This is a silent outage caused by what looks like a routine configuration change.

## Decision

Replace the inline `ingress`/`egress` arrays with individual `SecurityGroupIngressRule` and `SecurityGroupEgressRule` resources:

```typescript
const sg = new aws.ec2.SecurityGroup('clawops-sg', {
  vpcId: vpc.id,
  description: 'clawops managed security group',
})

sshIngressCidrs.forEach((cidr, i) => {
  new aws.vpc.SecurityGroupIngressRule(`clawops-sg-ssh-${i}`, {
    securityGroupId: sg.id,
    ipProtocol: 'tcp',
    fromPort: 22,
    toPort: 22,
    cidrIpv4: cidr,
  })
})
// ... gateway rules and egress rule similarly
```

Each rule is a separate Pulumi resource with its own URN. Pulumi can now add or remove individual CIDRs without touching the Security Group itself, eliminating the replacement window.

## Migration impact on existing stacks

**This is a breaking change for stacks provisioned before this ADR.**

On the first `clawops up` after this change, Pulumi will:
1. Delete the old `SecurityGroup` resource (with inline rules).
2. Create a new `SecurityGroup` (no inline rules).
3. Create individual `SecurityGroupIngressRule`/`SecurityGroupEgressRule` resources.

Steps 1 and 2 will briefly disconnect the existing EC2 instance from its security group. To minimise risk on production stacks, operators should:

```bash
# Option A — Planned maintenance window (recommended)
clawops up --stack <name>  # accept the replacement during off-hours

# Option B — Import existing SG, then migrate rules
# 1. Note the existing SG ID from the AWS console or state output
# 2. pulumi import aws:ec2/securityGroup:SecurityGroup clawops-sg sg-XXXXXXXX
# 3. pulumi up — Pulumi will adopt the existing SG and add rules without replacement
```

Option B avoids the replacement entirely but requires manual state manipulation. Document the SG ID before proceeding.

## Consequences

- **Positive:** CIDR changes no longer cause Security Group replacement or connectivity outages.
- **Positive:** Each rule resource has its own tags and can be individually tracked.
- **Negative:** One-time replacement of existing SG on first `up` after upgrade.
- **Neutral:** Slightly more verbose program code; test mocks updated to register new resource types.

## When to revisit

If Pulumi's AWS provider introduces a native mechanism to add/remove inline rules without SG replacement, this decision can be revisited. As of @pulumi/aws v6.x this mechanism does not exist.
