// Public API for the hardening framework.
// Import from here rather than individual module files.

export * from './types.js'
export { runHardening, withRemoteExec, formatHardenSummary, resolveModules } from './runner.js'

// Common modules (all providers)
export { sshModule } from './modules/ssh.js'
export { ufwModule, makeUfwModule } from './modules/ufw.js'
export { fail2banModule } from './modules/fail2ban.js'
export { unattendedUpgradesModule } from './modules/unattended-upgrades.js'
export { dockerSocketModule } from './modules/docker-socket.js'
export { auditdModule } from './modules/auditd.js'
export { lynisModule } from './modules/lynis.js'
export { sysctlModule } from './modules/sysctl.js'

// AWS-specific modules
export { awsSgAuditModule } from './modules/aws-sg-audit.js'
export { awsSsmCheckModule } from './modules/aws-ssm-check.js'
export { awsFlowLogsModule } from './modules/aws-flow-logs.js'
export { awsGuardDutyModule } from './modules/aws-guardduty.js'

import type { HardeningModule } from './types.js'
import { sshModule } from './modules/ssh.js'
import { ufwModule } from './modules/ufw.js'
import { fail2banModule } from './modules/fail2ban.js'
import { unattendedUpgradesModule } from './modules/unattended-upgrades.js'
import { dockerSocketModule } from './modules/docker-socket.js'
import { auditdModule } from './modules/auditd.js'
import { lynisModule } from './modules/lynis.js'
import { sysctlModule } from './modules/sysctl.js'
import { awsSgAuditModule } from './modules/aws-sg-audit.js'
import { awsSsmCheckModule } from './modules/aws-ssm-check.js'
import { awsFlowLogsModule } from './modules/aws-flow-logs.js'
import { awsGuardDutyModule } from './modules/aws-guardduty.js'

/** Full catalog of all hardening modules, ordered as they appear in the wizard. */
export const MODULE_CATALOG: HardeningModule[] = [
  // ON by default — common
  sshModule,
  ufwModule,
  fail2banModule,
  unattendedUpgradesModule,
  dockerSocketModule,
  // OFF by default — common
  auditdModule,
  lynisModule,
  sysctlModule,
  // AWS-specific
  awsSgAuditModule,
  awsSsmCheckModule,
  awsFlowLogsModule,
  awsGuardDutyModule,
]
