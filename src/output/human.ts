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
