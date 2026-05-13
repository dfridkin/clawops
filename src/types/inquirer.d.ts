declare module 'inquirer' {
  interface Question {
    type: string
    name: string
    message: string
    choices?: Array<{ name: string; value: unknown; checked?: boolean }> | Array<string>
    default?: unknown
    validate?: (v: unknown) => boolean | string | Promise<boolean | string>
    pageSize?: number
  }
  interface Inquirer {
    prompt<T>(questions: Question[]): Promise<T>
  }
  const inquirer: Inquirer
  export default inquirer
}
