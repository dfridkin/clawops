---
'@clawops/cli': patch
---

**A deploy that times out now says what the host was doing.**

When the gateway never appears, clawops used to report:

```
The OpenClaw gateway did not answer within 600s. Container: not found.
The instance is up — `clawops logs --stack <name>` shows what it is doing.
```

— advice that assumes the instance is still there to look at. An automated run destroys it on
the way out, and the evidence goes with it. That happened on the third Azure end-to-end run: the
container never appeared, and by the time anyone could look, the teardown had deleted the VM.

The timeout error now carries the last of the host's bootstrap log — cloud-init's output, or
GCP's startup-script unit — read over the connection that is already open. The diagnostic
swallows its own failures: it runs when something has already gone wrong, and a diagnostic that
throws would replace the real error with its own.
