// Human-readable output helpers — wraps chalk + ora.
// All command handlers must use these instead of console.log directly.

import chalk from 'chalk'
import ora, { type Ora } from 'ora'

export { chalk }

export function success(msg: string): void {
  console.log(chalk.green('✓') + '  ' + msg)
}

export function failure(msg: string): void {
  console.error(chalk.red('✗') + '  ' + msg)
}

export function warn(msg: string): void {
  console.warn(chalk.yellow('⚠') + '  ' + msg)
}

export function info(msg: string): void {
  console.log(chalk.blue('ℹ') + '  ' + msg)
}

export function spinner(text: string): Ora {
  return ora(text).start()
}

export const REPO_URL = 'https://github.com/dfridkin/clawops'

export function printCta(): void {
  process.stdout.write(
    '\n' +
    chalk.dim('  Thank you for using clawops! If it has been useful, star the project:') + '\n' +
    chalk.dim('  ' + REPO_URL) + '\n' +
    '\n' +
    chalk.dim('  Found a bug? Open an issue:') + '\n' +
    chalk.dim('  ' + REPO_URL + '/issues') + '\n' +
    '\n',
  )
}
