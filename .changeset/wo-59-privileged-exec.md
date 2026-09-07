---
"@clawops/cli": patch
---

Fix every day-2 command on AWS: escalate for Docker when the SSH user cannot reach it

**`gateway restart`, `logs`, `monitor`, `backup`, `agents`, `config set` and `doctor`'s
container checks have all been broken on AWS.** clawops connects to AWS as `ubuntu`, but
provisioning only puts `clawops` in the docker group, so every Docker command came back
with `permission denied while trying to connect to the Docker daemon socket`. GCP and Azure
connect as `clawops`, which is in the group — which is why only AWS was affected, and why
this went unnoticed.

A second failure hid behind the first. The gateway token lives in
`/home/clawops/openclaw.env`, inside a `750 clawops` directory. The restart command tests
for it with `$([ -s … ] && echo --env-file …)`, and that test evaluated as `ubuntu` — false
— so even with Docker access the gateway would have started with no token and exited 78
with "Refusing to bind gateway to auto without auth".

Both are fixed by routing every remote Docker invocation through one place that escalates
only when the host requires it, and that **single-quotes** the escalated command so
expansions happen in the privileged shell rather than the unprivileged one. The previous
fallback used double quotes, which evaluated `$(...)` before `sudo` ever ran.

Escalation is decided once per connection rather than per command, and only a
permission-shaped failure triggers it — `docker inspect` on an absent container still means
"not there", not "not allowed".

`plan/remote-config.ts` had carried a private version of this fix for some time, with a
comment naming the AWS case exactly. It was applied where the bug was reported rather than
across the surface it belonged to; nine other files kept calling Docker directly. A test now
fails if any command file invokes Docker on a raw session.
