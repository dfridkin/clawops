---
'@clawops/cli': patch
---

**A failed SSH connection now says what failed, not which syscall returned.** clawops passed ssh2's
text through unchanged — `SSH connection failed: connect ECONNREFUSED 34.70.45.162:22` — which is
true and tells an operator nothing about what to check. The distinction that matters most was the
one being thrown away: a *refused* connection means the packet arrived and nothing is listening, so
the instance is up and sshd is not; a *timeout* means nothing came back at all, and on a clawops
stack that is usually the security group, because `--ssh-cidr auto` admits the address the plan was
made from and home, office and VPN addresses change. The timeout message now names that cause and
prints the two commands that fix it.

The authentication message names the key clawops offered and says its public half may not be
installed on the host, rather than implying the key is wrong and sending someone to regenerate the
one thing that was fine. A name that does not resolve, and a handshake with no algorithm in common,
each say what they are. Every message keeps ssh2's own words, because operators paste them into
issues — and because the readiness wait classifies retryable failures by reading them.

**`clawops doctor --stack <name>` carries the same advice**, on its own line. It is where an
operator goes when nothing can reach a host, and it previously rendered the whole explanation as
one run-on line after a 13-column label, or no explanation at all.

None of this fires while clawops is waiting for a new instance to boot, where a refused connection
is the expected answer and "the instance is up and sshd is not" would be advice about a problem
that does not exist.
