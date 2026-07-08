---
"@clawops/cli": minor
---

Add `clawops harden` command — server hardening MVP (WO-29, WO-30, WO-33)

**New command: `clawops harden`**

`clawops harden [--stack <name>] [--options ssh,ufw,...] [--dry-run] [--list]`

Runs an idempotent set of hardening modules against a deployed stack over SSH. Each module has a `check()` (read-only) and `apply()` (makes the change) step. `check()` runs first; if already satisfied, `apply()` is skipped. Sentinel files at `/etc/clawops/hardening/<module>.applied` detect previous runs without re-reading full system config.

**Common modules (all providers) — ON by default:**
- `ssh` — hardens `sshd_config`: `PermitRootLogin no`, `PasswordAuthentication no`, `MaxAuthTries 3`, `LoginGraceTime 30`. Guards against lockout by verifying `authorized_keys` is non-empty before restarting sshd.
- `ufw` — sets UFW to deny-all incoming, allows SSH + gateway (18789) ports, enables.
- `fail2ban` — installs fail2ban with SSH jail: 5 failures → 10-minute ban.
- `unattended-upgrades` — enables security-only automatic updates.
- `docker-socket` — verifies `/var/run/docker.sock` is `root:docker 660`.

**Common modules — opt-in:**
- `auditd` — kernel audit logging for privileged commands.
- `lynis` — CIS Level 1 benchmark scan; saves full report to `~/.clawops/reports/`.
- `sysctl` — hardens kernel settings: `ip_forward=0`, TCP SYN cookies, no ICMP redirects.

**AWS modules (WO-30) — ON by default (check-only):**
- `aws-sg-audit` — warns if any Security Group ingress rule allows `0.0.0.0/0` on unexpected ports.
- `aws-ssm-check` — verifies the instance IAM role has `AmazonSSMManagedInstanceCore` for emergency SSM shell access.

**AWS modules — opt-in:**
- `aws-flow-logs` — enables VPC Flow Logs → CloudWatch (billed per GB).
- `aws-guardduty` — enables GuardDuty threat detection (~$4/mo per account).

**Setup wizard integration**

`clawops setup` now presents a multi-select hardening step after deploy (pre-checked: ssh, ufw, fail2ban, unattended-upgrades, docker-socket). Skippable with `--no-harden`.

**Doctor integration**

`clawops doctor --stack <name>` now includes a Hardening section showing which modules are applied, missing, or drifted.

**New dependencies:** `@aws-sdk/client-ec2`, `@aws-sdk/client-iam`, `@aws-sdk/client-guardduty`, `@aws-sdk/client-cloudwatch-logs` (AWS hardening modules only; tree-shaken in the bundle for non-AWS deployments).
