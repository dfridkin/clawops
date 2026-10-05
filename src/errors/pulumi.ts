// Getting the cause out of a Pulumi automation failure.

/**
 * The informative line of whatever was thrown.
 *
 * A Pulumi CommandError's message opens with "code: -2" and buries the cause several lines
 * down, in the captured stderr:
 *
 *   code: -2
 *    stdout:
 *    stderr: … error: could not list bucket: NoSuchBucket: The specified bucket does not exist
 *
 * Reporting the first line would hand the operator an exit code where the answer was available.
 */
export function pulumiCause(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  const lines = raw.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  const explained = lines.find((l) => /(^|\s)error:/i.test(l))
  if (explained) return explained.replace(/^.*?error:\s*/i, '')
  return lines[0] ?? raw
}
