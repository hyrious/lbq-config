import { type ExecFileSyncOptions, execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';

const defaultExecOptions: ExecFileSyncOptions = {
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'inherit']
}

export function exec(cmd: string, args: readonly string[], options?: ExecFileSyncOptions): string | null {
  try {
    return execFileSync(cmd, args, { ...defaultExecOptions, ...options, encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

export function execOrFail(cmd: string, args: readonly string[], options?: ExecFileSyncOptions): string {
  try {
    return execFileSync(cmd, args, { ...defaultExecOptions, ...options, encoding: 'utf8' }).trim();
  } catch {
    process.exit(1);
  }
}

export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })

  try {
    const answer = await rl.question(`${question} (Y/n) `)
    return ['y', 'yes', ''].includes(answer.trim().toLowerCase())
  } finally {
    rl.close()
  }
}
export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export function bool(argv: string[], flag: string | string[]): boolean {
  if (Array.isArray(flag)) {
    return flag.map(f => bool(argv, f)).reduce((a, b) => a || b)
  }
  if (flag[0] !== '-') {
    flag = flag.length == 1 ? '-' + flag : '--' + flag
  }
  const index = argv.indexOf(flag)
  if (index >= 0) {
    argv.splice(index, 1)
    return true
  }
  return false
}

export function str(argv: string[], flag: string | string[]): string | undefined {
  if (Array.isArray(flag)) {
    for (const f of flag) {
      const v = str(argv, f)
      if (v != null) return v
    }
    return
  }
  if (flag[0] !== '-') {
    flag = flag.length == 1 ? '-' + flag : '--' + flag
  }
  const i = argv.findIndex(arg => arg == flag || arg.startsWith(flag + '='))
  if (i < 0) return
  const arg = argv[i]
  if (arg == flag) {
    const v = argv[i + 1]
    argv.splice(i, v == null ? 1 : 2)
    return v
  }
  argv.splice(i, 1)
  return arg.slice(flag.length + 1)
}

export function editFile(file: string): void {
  const editors = ['subl', 'code', 'edit', 'vim']
  for (const editor of editors) {
    try {
      execFileSync(editor, [file], { stdio: 'inherit' })
      return
    } catch (e) {
      if (e.code != 'ENOENT' || editor == editors.at(-1)) throw e;
    }
  }
}

export function readJson<T>(file: string, defaultValue: T): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return defaultValue
  }
}

export function writeJson(file: string, value: unknown): void {
  const content = JSON.stringify(value, (_, value) => {
    if (value && typeof value == 'object' && !Array.isArray(value)) {
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]))
    }
    return value
  }, 2)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content + '\n')
}

export function truncate(text: string, length: number): string {
  return text.length > length ? text.slice(0, length - 1) + '…' : text
}
