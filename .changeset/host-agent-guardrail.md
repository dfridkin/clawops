---
"@clawops/cli": minor
---

A host agent refuses every call unless only its operator can reach it. Checked against `openclaw.json` on each call: the agent is not the gateway's default and nothing but the operator's direct-message bindings routes to it, those channels' DM policy is explicitly `pairing` or `allowlist`, agent-to-agent access and session visibility cannot reach it, and every other agent is denied the clawops tools.
