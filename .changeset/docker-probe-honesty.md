---
'@clawops/cli': patch
---

**A healthy deployment could be reported as missing, indefinitely.**

Every Docker probe was written like this:

```bash
docker inspect openclaw --format '{{.State.Status}}' 2>/dev/null || echo 'not found'
```

which discards stderr and exits 0 whatever happened. clawops escalates to `sudo` when a command
looks like it was refused the Docker socket — and it tests the exit code first, so a command
that always succeeds never escalates. The permission error was laundered into a confident
`not found`, and the session cached that `sudo` was not needed.

On a real deploy, `clawops apply` waited ten minutes for a container that was `Up 9 minutes
(healthy)` throughout. It is intermittent because the SSH user's membership of the `docker`
group is fixed when the session opens, and clawops connects as soon as `sshd` answers —
sometimes before the host has run `usermod`.

A refusal and an absence are now different answers everywhere they are asked: `doctor` says
`could not ask docker — permission denied` rather than claiming the container is gone,
`gateway status` will not print "not running" when it does not know, `monitor` shows
`unreachable`, and the readiness wait stops on a refusal instead of polling through it.
