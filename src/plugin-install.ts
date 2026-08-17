import { join } from 'node:path'
import { fetchOpts } from './api.js'
import { dshHome } from './config-store.js'
import { fetchJson } from './http.js'
import { installPlanUrl, parsePluginRef } from './plugin-market.js'
import { runCommand } from './run-command.js'
import type { PluginConfig } from './types.js'

export type PluginInstallPhase =
  | 'init'
  | 'install-plan'
  | 'plugin-add'
  | 'auto-restart'
  | 'done'
  | 'failed'

export interface PluginInstallInput {
  owner: unknown
  name: unknown
  fullName?: unknown
  installability?: unknown
}

export interface InstallPlan {
  command?: string
  source?: string
  profile?: string
}

export interface PluginInstallResult {
  ok: boolean
  fullName: string
  source?: string
  profile?: string
  command?: string
  phase: PluginInstallPhase
  autoRestartRequested: boolean
  message: string
  log?: string
  error?: string
}

export interface PluginInstallDeps {
  fetchJson: typeof fetchJson
  runCommand: typeof runCommand
  profileDir: (profile: string) => string
  requestRestart: () => void
  scheduleRestart?: (fn: () => void, ms: number) => void
}

const defaultDeps: PluginInstallDeps = {
  fetchJson,
  runCommand,
  profileDir: (profile) => join(dshHome(), 'profiles', profile),
  requestRestart: () => {
    process.kill(process.pid, 'SIGTERM')
  },
  scheduleRestart: (fn, ms) => {
    setTimeout(fn, ms)
  },
}

const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/
const SOURCE_RE = /^(github:[^\s]+|https?:\/\/\S+|link:\S+|file:\S+|\/\S+)$/i

export function assertVerifiedInstallability(raw: unknown): void {
  if (raw !== 'verified') {
    throw new Error('仅 installability=verified 的插件可直装')
  }
}

/** Prefer install-plan.source; fall back to parsing `dsh plugin … add <spec>`. */
export function resolveInstallPlan(raw: unknown): { command: string; source: string; profile: string } {
  if (!raw || typeof raw !== 'object') throw new Error('install-plan 无效')
  const plan = raw as InstallPlan
  const profile = String(plan.profile || '').trim()
  if (!PROFILE_RE.test(profile)) throw new Error('install-plan 缺少有效 profile')

  let source = String(plan.source || '').trim()
  const command = String(plan.command || '').trim()
  if (!source && command) {
    const m = command.match(/\badd\s+(\S+)/i)
    if (m) source = m[1]
  }
  if (!source) throw new Error('install-plan 缺少 source/command')
  if (!SOURCE_RE.test(source)) throw new Error(`install-plan source 无效: ${source}`)
  if (!command) {
    return {
      command: `dsh plugin --profile ${profile} add ${source}`,
      source,
      profile,
    }
  }
  if (!/\bplugin\b/i.test(command) || !/\badd\b/i.test(command)) {
    throw new Error('install-plan command 不是 dsh plugin add')
  }
  return { command, source, profile }
}

export function buildPluginAddArgs(profile: string, source: string): string[] {
  return ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', profile, 'add', source]
}

export async function fetchInstallPlan(
  cfg: PluginConfig,
  owner: string,
  name: string,
  deps: Pick<PluginInstallDeps, 'fetchJson'> = defaultDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = installPlanUrl(cfg.apiBase, owner, name)
  return deps.fetchJson(url, fetchOpts(cfg), signal)
}

export async function installMarketPlugin(
  cfg: PluginConfig,
  input: PluginInstallInput,
  deps: PluginInstallDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<PluginInstallResult> {
  const ref = parsePluginRef(input.owner, input.name)
  const fullName = String(input.fullName || ref.fullName).trim() || ref.fullName
  const fail = (phase: PluginInstallPhase, error: string): PluginInstallResult => ({
    ok: false,
    fullName,
    phase,
    autoRestartRequested: false,
    message: error,
    error,
  })

  try {
    assertVerifiedInstallability(input.installability)
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err))
  }

  let resolved: { command: string; source: string; profile: string }
  try {
    const plan = await fetchInstallPlan(cfg, ref.owner, ref.name, deps, signal)
    resolved = resolveInstallPlan(plan)
  } catch (err) {
    return fail('install-plan', err instanceof Error ? err.message : String(err))
  }

  const cwd = deps.profileDir(resolved.profile)
  const args = buildPluginAddArgs(resolved.profile, resolved.source)
  let log = ''
  try {
    log = await deps.runCommand('npx', args, {
      cwd,
      timeoutMs: Math.max(cfg.timeoutMs, 120000),
      signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      ok: false,
      fullName,
      source: resolved.source,
      profile: resolved.profile,
      command: resolved.command,
      phase: 'plugin-add',
      autoRestartRequested: false,
      message: msg,
      error: msg,
      log: log.slice(-4000) || undefined,
    }
  }

  const schedule = deps.scheduleRestart || ((fn, ms) => setTimeout(fn, ms))
  schedule(() => {
    try {
      deps.requestRestart()
    } catch {
      // ignore restart signaling errors after successful install
    }
  }, 400)

  return {
    ok: true,
    fullName,
    source: resolved.source,
    profile: resolved.profile,
    command: resolved.command,
    phase: 'auto-restart',
    autoRestartRequested: true,
    message:
      `已直装 ${fullName} 并请求自动重启 dsh（SIGTERM 优雅退出）。` +
      '推荐在有 KeepAlive/supervisor 的环境使用；无外部守护时进程退出后需自行拉起。',
    log: log.slice(-4000),
  }
}
