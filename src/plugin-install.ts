import { join } from 'node:path'
import { fetchOpts } from './api.js'
import { dshHome } from './config-store.js'
import { fetchJson } from './http.js'
import {
  installPlanUrl,
  mapMarketPlugin,
  parsePluginRef,
  pluginDetailUrl,
  type MarketPlugin,
} from './plugin-market.js'
import { runCommand } from './run-command.js'
import type { FetchOptions, PluginConfig } from './types.js'

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
  /** Client hint only; Host ignores this and re-checks upstream. */
  installability?: unknown
}

export interface InstallPlanPlugin {
  fullName?: unknown
  headSha?: unknown
}

export interface InstallPlan {
  command?: string
  source?: string
  profile?: string
  installability?: unknown
  plugin?: InstallPlanPlugin
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

/** Profile names: no path traversal (`.` / `..` / separators). */
const PROFILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
/** Only full commit-pinned github specs: github:owner/repo#<40-hex-sha>. */
const PINNED_GITHUB_RE =
  /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})#([a-fA-F0-9]{40})$/
const DEFAULT_INSTALL_API_HOSTS = new Set(['api.skillhub.cn'])

export function assertVerifiedInstallability(raw: unknown): void {
  if (raw !== 'verified') {
    throw new Error('仅 installability=verified 的插件可直装')
  }
}

export function assertSafeInstallApiBase(apiBase: string): void {
  let url: URL
  try {
    url = new URL(String(apiBase || '').trim())
  } catch {
    throw new Error('apiBase 无效')
  }
  if (url.protocol !== 'https:') {
    throw new Error('市场直装要求 apiBase 使用 https')
  }
  const host = url.hostname.toLowerCase()
  const allowCustom = process.env.SKILLHUB_ALLOW_CUSTOM_API_BASE === '1'
  if (!DEFAULT_INSTALL_API_HOSTS.has(host) && !allowCustom) {
    throw new Error(
      '市场直装仅允许官方 API 主机（api.skillhub.cn）；自定义 apiBase 需设置环境变量 SKILLHUB_ALLOW_CUSTOM_API_BASE=1',
    )
  }
}

export function assertPinnedGithubSource(
  source: string,
  expected?: { owner: string; name: string },
): string {
  const raw = String(source || '').trim()
  const m = raw.match(PINNED_GITHUB_RE)
  if (!m) {
    throw new Error(
      'install-plan source 必须为 commit-pinned github:owner/repo#<40-hex-sha>，拒绝 file/link/http(s)/绝对路径、短 SHA 与浮动分支',
    )
  }
  const owner = m[1]
  const name = m[2]
  const sha = m[3].toLowerCase()
  if (expected) {
    if (owner.toLowerCase() !== expected.owner.toLowerCase() || name.toLowerCase() !== expected.name.toLowerCase()) {
      throw new Error(`install-plan source 与请求插件不一致: 期望 ${expected.owner}/${expected.name}`)
    }
  }
  return `github:${owner}/${name}#${sha}`
}

function installFetchOpts(cfg: PluginConfig): FetchOptions {
  return { ...fetchOpts(cfg), redirect: 'error' }
}

/** Prefer install-plan.source; fall back to parsing `dsh plugin … add <spec>`. */
export function resolveInstallPlan(
  raw: unknown,
  expected?: { owner: string; name: string },
): { command: string; source: string; profile: string } {
  if (!raw || typeof raw !== 'object') throw new Error('install-plan 无效')
  const plan = raw as InstallPlan
  const profile = String(plan.profile || '').trim()
  if (!PROFILE_RE.test(profile) || profile.includes('..')) throw new Error('install-plan 缺少有效 profile')

  let source = String(plan.source || '').trim()
  const command = String(plan.command || '').trim()
  if (!source && command) {
    const m = command.match(/\badd\s+(\S+)/i)
    if (m) source = m[1]
  }
  if (!source) throw new Error('install-plan 缺少 source/command')
  source = assertPinnedGithubSource(source, expected)
  assertPlanPluginIdentity(plan, expected, source)
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

/** When install-plan includes plugin identity, it must match the requested ref and pinned sha. */
export function assertPlanPluginIdentity(
  plan: InstallPlan,
  expected: { owner: string; name: string } | undefined,
  source: string,
): void {
  const plugin = plan.plugin
  if (!plugin || typeof plugin !== 'object') return
  const fullName = String(plugin.fullName || '').trim()
  if (expected && fullName) {
    const want = `${expected.owner}/${expected.name}`.toLowerCase()
    if (fullName.toLowerCase() !== want) {
      throw new Error(`install-plan plugin.fullName 与请求不一致: ${fullName}`)
    }
  }
  const headSha = String(plugin.headSha || '').trim().toLowerCase()
  if (headSha) {
    const sourceSha = source.split('#')[1]?.toLowerCase() || ''
    if (!/^[a-f0-9]{40}$/.test(headSha) || headSha !== sourceSha) {
      throw new Error('install-plan source sha 与 plugin.headSha 不一致')
    }
  }
}

export function buildPluginAddArgs(profile: string, source: string): string[] {
  return ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', profile, 'add', source]
}

export async function fetchUpstreamPlugin(
  cfg: PluginConfig,
  owner: string,
  name: string,
  deps: Pick<PluginInstallDeps, 'fetchJson'> = defaultDeps,
  signal?: AbortSignal,
): Promise<MarketPlugin | null> {
  const url = pluginDetailUrl(cfg.apiBase, owner, name)
  const body = await deps.fetchJson<unknown>(url, installFetchOpts(cfg), signal)
  const mapped = mapMarketPlugin(body)
  if (!mapped) return null
  if (mapped.owner.toLowerCase() !== owner.toLowerCase() || mapped.name.toLowerCase() !== name.toLowerCase()) {
    return null
  }
  return mapped
}

export async function assertUpstreamVerified(
  cfg: PluginConfig,
  owner: string,
  name: string,
  deps: Pick<PluginInstallDeps, 'fetchJson'> = defaultDeps,
  signal?: AbortSignal,
): Promise<void> {
  const hit = await fetchUpstreamPlugin(cfg, owner, name, deps, signal)
  assertVerifiedInstallability(hit?.installability)
}

export async function fetchInstallPlan(
  cfg: PluginConfig,
  owner: string,
  name: string,
  deps: Pick<PluginInstallDeps, 'fetchJson'> = defaultDeps,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = installPlanUrl(cfg.apiBase, owner, name)
  return deps.fetchJson(url, installFetchOpts(cfg), signal)
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
    assertSafeInstallApiBase(cfg.apiBase)
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err))
  }

  // Hard gate: ignore client installability; verify from upstream catalog.
  try {
    await assertUpstreamVerified(cfg, ref.owner, ref.name, deps, signal)
  } catch (err) {
    return fail('failed', err instanceof Error ? err.message : String(err))
  }

  let resolved: { command: string; source: string; profile: string }
  try {
    const plan = await fetchInstallPlan(cfg, ref.owner, ref.name, deps, signal)
    if (plan && typeof plan === 'object' && 'installability' in plan) {
      assertVerifiedInstallability((plan as InstallPlan).installability)
    }
    resolved = resolveInstallPlan(plan, ref)
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
