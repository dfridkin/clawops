---
'@clawops/cli': minor
---

**Spending limits: say which server sizes clawops may deploy, and how many deployments it may
manage.** An optional `policy` block in `~/.clawops/config.json`:

```json
"policy": { "allowedInstanceTypes": { "aws": ["micro", "small"] }, "maxStacks": 3 }
```

`clawops plan`, `apply` and `up` refuse a size outside the list for that provider, and `clawops
init` refuses a new stack beyond the cap. Sizes are compared after mapping, so `small` and
`t3.small` are the same entry on AWS. Every MCP tool that deploys is held to the same limits in the
same words, and no tool can change them: until now nothing stopped an agent, or a retry loop,
from deploying any size the cloud offers, as many times as it liked.

`clawops setup` asks whether to set them before it asks for a server size, and then offers only
the sizes you allowed. The limit lives in config rather than in the deploy plan because a plan is
what an agent writes.
