/**
 * Spawn `dsh plugin` from the host process. Do not use the agent's sandboxed
 * shell: it cannot write the profile directory.
 */

import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { dshHome } from './config-store.js'

export const WEB_PROFILE = 'web'
export const INSTALL_TIMEOUT_MS = Number(process.env.SKILLHUB_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

const TARGET_RE = /^[A-Za-z0-9@:./_#+-]+$/
const CMD_METACHARS = /[\s"&|<>^()%!]/

export type PluginRunner = (profile: string, pluginArgs: string[]) => Promise<string>

export interface DshArgv {
  file: string
  args: string[]
  cwd: string | undefined
  viaShell: boolean
}

export interface RunCommandOptions {
  cwd?: string
  timeoutMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  viaShell?: boolean
  detached?: boolean
}

export function webProfileDir(): string {
  return join(dshHome(), 'profiles', WEB_PROFILE)
}

export function isSafePluginTarget(target: string): boolean {
  return TARGET_RE.test(target)
}

export function quoteCmdArg(arg: string): string {
  if (!CMD_METACHARS.test(arg)) return arg
  return `"${arg.replace(/"/g, '""')}"`
}

export function cmdCommandLine(argv: readonly string[]): string {
  return argv.map(quoteCmdArg).join(' ')
}

export function dshArgv(input: {
  argv?: readonly string[]
  execArgv?: readonly string[]
  execPath?: string
  argv0?: string
  platform?: NodeJS.Platform
} = {}): DshArgv {
  const argv = input.argv ?? process.argv
  const execArgv = input.execArgv ?? process.execArgv
  const execPath = input.execPath ?? process.execPath
  const argv0 = input.argv0 ?? process.argv0
  const platform = input.platform ?? process.platform
  const node = nodeExecutable(argv0, execPath)
  const entry = argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: node, args: [...execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  return { file: 'dsh', args: [], cwd: undefined, viaShell: platform === 'win32' }
}

export function nodeExecutable(argv0: string | undefined = process.argv0, execPath: string = process.execPath): string {
  if (argv0 !== undefined && argv0 !== '' && isAbsolute(argv0) && existsSync(argv0)) return argv0
  return execPath
}

/** pnpm 9 needs -w at a workspace root; every major rejects -w outside one. */
export function pluginArgsFor(profileDirectory: string, pluginArgs: readonly string[]): string[] {
  const args = [...pluginArgs]
  if (args[0] !== 'add' && args[0] !== 'remove') return args
  if (!existsSync(join(profileDirectory, 'pnpm-workspace.yaml'))) return args
  return [args[0], '-w', ...args.slice(1)]
}

export function rewritePnpmError(err: unknown): Error {
  const text = err instanceof Error ? err.message : String(err)
  if (/needs to execute build scripts|allowBuilds|ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(text)) {
    return new Error('该插件需要构建脚本（prepare），pnpm 默认拦截。请改用 npm 包安装，或在 profile 的 pnpm-workspace.yaml 中配置 allowBuilds。')
  }
  if (/ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF/.test(text)) {
    return new Error('当前 profile 的 node_modules 由不同主版本的 pnpm 生成，安装前需要先重建依赖。')
  }
  return err instanceof Error ? err : new Error(text)
}

export async function runDshPlugin(
  profile: string,
  pluginArgs: string[],
  deps: {
    runCommand?: typeof runCommand
    dshArgv?: typeof dshArgv
    profileDir?: string
  } = {},
): Promise<string> {
  if (profile !== WEB_PROFILE) throw new Error('仅支持 web profile')
  const target = pluginArgs[pluginArgs.length - 1] ?? ''
  if (!isSafePluginTarget(target)) throw new Error(`拒绝不安全的安装目标: ${target}`)
  const argv = (deps.dshArgv ?? dshArgv)()
  const args = pluginArgsFor(deps.profileDir ?? webProfileDir(), pluginArgs)
  const run = deps.runCommand ?? runCommand
  return run(argv.file, [...argv.args, 'plugin', '--profile', profile, ...args], {
    cwd: argv.cwd,
    timeoutMs: INSTALL_TIMEOUT_MS,
    env: { CI: 'true' },
    viaShell: argv.viaShell,
    detached: process.platform !== 'win32',
  })
}

export async function addDshPlugin(
  source: string,
  deps: { runDshPlugin?: PluginRunner } = {},
): Promise<string> {
  const run = deps.runDshPlugin ?? runDshPlugin
  try {
    return await run(WEB_PROFILE, ['add', source])
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (text.includes('ERR_PNPM_PUBLIC_HOIST_PATTERN_DIFF')) {
      await run(WEB_PROFILE, ['install', '--no-frozen-lockfile'])
      try {
        return await run(WEB_PROFILE, ['add', source])
      } catch (retryErr) {
        throw rewritePnpmError(retryErr)
      }
    }
    throw rewritePnpmError(err)
  }
}

export function runCommand(
  command: string,
  args: string[],
  options: RunCommandOptions,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawnShim(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
      viaShell: options.viaShell === true,
      detached: options.detached === true && process.platform !== 'win32',
    })
    let out = ''
    let settled = false
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolvePromise(out)
    }
    const timer = setTimeout(() => {
      killChild(child)
      finish(new Error(`命令超时 ${options.timeoutMs}ms`))
    }, options.timeoutMs)
    const onAbort = () => {
      killChild(child)
      finish(new Error('命令已取消'))
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (chunk: Buffer) => { out = (out + chunk.toString()).slice(-256 * 1024) })
    child.stderr?.on('data', (chunk: Buffer) => { out = (out + chunk.toString()).slice(-256 * 1024) })
    child.on('error', (err) => finish(err))
    child.on('close', (code) => {
      if (code === 0) finish()
      else finish(new Error(`命令失败 (exit ${code}): ${out.trim().slice(-800) || 'no output'}`))
    })
  })
}

type SpawnShimOptions = SpawnOptions & { viaShell?: boolean }

function spawnShim(file: string, args: readonly string[], options: SpawnShimOptions): ChildProcess {
  const { viaShell = false, ...spawnOptions } = options
  if (!viaShell || process.platform !== 'win32') {
    return spawn(file, [...args], { ...spawnOptions, shell: false })
  }
  const comspec = process.env.ComSpec ?? 'cmd.exe'
  return spawn(comspec, ['/d', '/s', '/c', `"${cmdCommandLine([file, ...args])}"`], {
    ...spawnOptions,
    shell: false,
    windowsVerbatimArguments: true,
  })
}

function killChild(child: ChildProcess): void {
  if (process.platform !== 'win32' && child.pid !== undefined) {
    try {
      process.kill(-child.pid, 'SIGTERM')
      return
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    /* already gone */
  }
}
