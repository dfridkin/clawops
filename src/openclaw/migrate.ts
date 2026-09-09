// Migrating a 1.x deployment to the 2.0 runtime contract.
//
// SP-07 established that the obvious sequence is wrong in two ways, and a re-run on
// 2026-09-09 added a third:
//
//  1. There is nothing on the host to relocate. All 1.x state lives INSIDE the container,
//     so it must be extracted from the RUNNING one — stopping it first destroys what the
//     migration came to save.
//  2. There is no config to carry forward. 1.x never wrote one that applied (the mounted
//     file was read by nothing), and 2.0 refuses to start without `gateway.mode`. The
//     config must be SYNTHESISED, treating any old file as intent to review rather than
//     settings to apply — they have never been in force, and its channel blocks will not
//     validate.
//  3. The migration is not clean on the first start. 2.0 reports "state database schema
//     migration required (audit-events-v2)" and is healthy only after a SECOND start. So
//     the sequence gates, restarts, and re-gates rather than declaring success on the first.
//
// Measured on 2026-09-09 migrating 2026.7.1-2 → 2026.9.2: `deviceId` is preserved and
// `identity/` is emptied — relocation into SQLite, not loss.

export interface MigrateSteps {
  /** Is a 1.x container running? Returns its image, or undefined. */
  inspectSource: () => Promise<string | undefined>
  /** `openclaw backup create --verify` inside the RUNNING container. */
  backup: () => Promise<{ ok: boolean; detail: string }>
  /** Copy state out of the running container to the host state directory. */
  extract: () => Promise<{ ok: boolean; entries: string[] }>
  /** Numeric ownership — uid 1000, never a named user (G25). */
  chown: () => Promise<void>
  /** Stop and remove the 1.x container. */
  removeSource: () => Promise<void>
  /** Write a valid 2.0 config into the state directory. */
  writeConfig: () => Promise<void>
  /** Start the 2.0 gateway. */
  start: () => Promise<void>
  /** Poll `/startupz`. */
  gate: () => Promise<{ ok: boolean; reason?: string }>
  /** Read the deviceId, for continuity reporting. */
  deviceId: () => Promise<string | undefined>
}

export type MigrateOutcome =
  | { kind: 'migrated'; entries: string[]; identity: 'preserved' | 'changed' | 'unknown'; restarts: number }
  | { kind: 'nothing-to-migrate'; reason: string }
  | { kind: 'refused'; reason: string }
  | { kind: 'failed'; reason: string; backupDetail: string }

/**
 * Run the migration.
 *
 * Refuses before touching anything if there is no verified backup: this replaces a working
 * deployment's container, and the state it extracts is the only copy.
 */
export async function migrate(steps: MigrateSteps): Promise<MigrateOutcome> {
  const sourceImage = await steps.inspectSource()
  if (!sourceImage) {
    return {
      kind: 'nothing-to-migrate',
      reason:
        'No running OpenClaw container was found, so there is no 1.x state to extract. ' +
        'If this deployment was restarted on a clawops release before 2.0, its state was ' +
        'already lost — clawops mounted none, so every container replacement discarded it. ' +
        'Deploy fresh with `clawops up`.',
    }
  }

  // Before anything is stopped or moved.
  const identityBefore = await steps.deviceId()

  const backup = await steps.backup()
  if (!backup.ok) {
    return {
      kind: 'refused',
      reason:
        `Refusing to migrate without a verified backup: ${backup.detail}\n` +
        'This replaces the running container, and the state it extracts is the only copy.',
    }
  }

  // From the RUNNING container: stopping first destroys what this came to save.
  const extracted = await steps.extract()
  if (!extracted.ok) {
    return {
      kind: 'failed',
      reason: 'Could not extract state from the running container; it has not been touched.',
      backupDetail: backup.detail,
    }
  }

  await steps.chown()
  await steps.removeSource()
  await steps.writeConfig()
  await steps.start()

  // Two starts. The first performs the schema migration and reports it as pending; the
  // second comes up clean. Declaring success on the first would report a deployment that
  // is still converging.
  let restarts = 0
  let gate = await steps.gate()
  if (!gate.ok) {
    await steps.start()
    restarts = 1
    gate = await steps.gate()
  }

  if (!gate.ok) {
    return {
      kind: 'failed',
      reason: gate.reason ?? 'the gateway did not start after migration',
      backupDetail: backup.detail,
    }
  }

  const identityAfter = await steps.deviceId()
  const identity =
    identityBefore === undefined || identityAfter === undefined
      ? 'unknown'
      : identityBefore === identityAfter
        ? 'preserved'
        : 'changed'

  return { kind: 'migrated', entries: extracted.entries, identity, restarts }
}

/** Human report. Kept beside the state machine so message and branch cannot drift. */
export function describeMigration(o: MigrateOutcome): string {
  switch (o.kind) {
    case 'migrated': {
      const lines = [
        `Migrated to the 2.0 runtime contract. Carried over: ${o.entries.join(', ') || '(nothing)'}.`,
      ]
      if (o.restarts > 0) {
        lines.push(
          'The gateway needed a second start to finish its state-schema migration, which is ' +
            'expected for a 1.x database.',
        )
      }
      if (o.identity === 'preserved') {
        lines.push('Device identity preserved — paired devices do not need re-pairing.')
      } else if (o.identity === 'changed') {
        lines.push(
          'Device identity CHANGED. Paired devices and nodes must be re-paired — ' +
            'check `openclaw devices list` on the host for what was paired.',
        )
      } else {
        lines.push(
          'Device identity could not be compared, so pairings may or may not have carried ' +
            'over. Check `openclaw devices list` before relying on them.',
        )
      }
      lines.push('Your 1.x config was NOT applied — it never took effect on 1.x either. Review it')
      lines.push('and set what you need with `clawops config set`.')
      return lines.join('\n')
    }
    case 'nothing-to-migrate':
      return o.reason
    case 'refused':
      return o.reason
    case 'failed':
      return (
        `Migration failed: ${o.reason}\n` +
        `A verified backup was taken first: ${o.backupDetail}\n` +
        'Restore it with `clawops backup restore --file <archive>` before retrying.'
      )
  }
}
