---
'@clawops/cli': patch
---

**Day-two commands failed with an error about provider loading.**

`buildContext().adapter` was a proxy that loaded the provider module on its first *async* call,
so every synchronous method on it threw until something else had triggered that:

```
✗  Connection   Provider not yet loaded. Call getStack() first.
```

Eighteen call sites depended on that ordering and nothing enforced it. `clawops up` worked
because it awaits `validateConfig()` a few lines earlier; `clawops plan` did not, and against a
freshly deployed instance `doctor --stack`, `ssh`, `logs` and `gateway restart` all failed with
an error about provider loading rather than about the instance.

Adapters are registered when imported now, and the context hands back the real one. They are
small, and the Pulumi packages they eventually need load inside the program function, so
nothing heavy moves to startup.
