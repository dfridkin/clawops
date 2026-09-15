// Refuse to run the suite while the mutation checker has a source file mutated.
//
// The checker edits real files and puts them back between mutations. A suite run that lands in
// that window reads source nobody wrote and reports failures nobody caused — which happened
// twice in one session: a phantom lint error, and a docker test that "failed" because another
// file was mutated at that moment. Believing either would have cost a chase.
//
// The sentinel is the same file the checker uses to restore itself after being killed, so this
// needs no new bookkeeping: if it exists, a mutation is applied right now.

import { existsSync, readFileSync } from 'node:fs'

const SENTINEL = new URL('../../scripts/dev/.mutation-inflight.json', import.meta.url)

export default function setup(): void {
  if (!existsSync(SENTINEL)) return

  let file = 'a source file'
  try {
    file = (JSON.parse(readFileSync(SENTINEL, 'utf-8')) as { file?: string }).file ?? file
  } catch {
    // The sentinel exists but is unreadable — still a mutation in flight.
  }

  throw new Error(
    `A mutation check is running and ${file} is currently mutated.\n` +
      'Any result from this run would be about source nobody wrote. Wait for ' +
      '`pnpm test:mutation` to finish, or stop it, and run the tests again.',
  )
}
