---
'@clawops/cli': patch
---

**`clawops config validate` and `config set` check against the schema the pinned OpenClaw
actually has.** The schema clawops shipped had been captured from a different build than the
pinned 2026.9.2, and the weekly check that compares them failed to report it for five weeks: it
found the drift every Monday and then failed on a missing issue label. 82 values differed. The ones
that change what validation says: `messages.suppressToolErrors` no longer exists, so a config
setting it is now refused here, as the gateway refuses it, and `transcripts.autoStart[].whenOccupied`
is accepted.

Worth knowing from the same recapture: on 2026.9.2, cross-agent session access
(`tools.agentToAgent`) and collector-mode subagents (`tools.swarm`) are **on by default**. Set
`tools.agentToAgent.enabled: false`, or an `allow` list, if agents on one gateway should not read
each other's sessions.
