import { fetchOpts } from './api.js'
import { addDshPlugin, type PluginRunner } from './dsh-cli.js'
import { fetchJson } from './http.js'
import type { PluginConfig } from './types.js'

export type PluginScope = 'verified' | 'all'
export type PluginSort = 'stars' | 'updated'
export type PluginInstallability = 'verified' | 'unsupported'

/** Plugin 一级类目，与 Skill 的 `categories.ts` 无关。非法 key 会让目录接口 400。 */
export const PLUGIN_CATEGORIES: Record<string, string> = {
  'fun-dressup': '趣味换装',
  'web-tools': '联网工具',
  memory: '记忆',
  'agent-workflow': 'Agent 工作流',
  'model-inference': '模型推理',
  client: '客户端',
  'admin-security': '管理安全',
}

export const PLUGIN_CATEGORY_KEYS = Object.keys(PLUGIN_CATEGORIES)

export interface PluginCategory {
  key: string
  displayName: string
}

export interface MarketPlugin {
  owner: string
  name: string
  fullName: string
  description: string
  stars: number
  categoryKey: string
  installability: PluginInstallability
  repositoryUrl: string
  avatarUrl: string
}

export interface PluginListQuery {
  q?: unknown
  scope?: unknown
  category?: unknown
  sort?: unknown
  page?: unknown
  pageSize?: unknown
}

export interface PluginPage {
  items: MarketPlugin[]
  total: number
  page: number
  pageSize: number
  apiBase: string
  webBase: string
}

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/

export function parsePluginRef(owner: unknown, name: unknown): { owner: string; name: string; fullName: string } {
  const o = String(owner || '').trim()
  const n = String(name || '').trim()
  if (!OWNER_RE.test(o)) throw new Error('无效插件 owner')
  if (!NAME_RE.test(n)) throw new Error('无效插件 name')
  return { owner: o, name: n, fullName: `${o}/${n}` }
}

export function parsePluginCategory(raw: unknown): string | undefined {
  const key = String(raw || '').trim()
  if (!key) return undefined
  return PLUGIN_CATEGORY_KEYS.includes(key) ? key : undefined
}

export function sanitizePluginScope(raw: unknown): PluginScope {
  return raw === 'all' ? 'all' : 'verified'
}

export function sanitizePluginSort(raw: unknown): PluginSort {
  return raw === 'updated' ? 'updated' : 'stars'
}

function pluginPageSize(raw: unknown): number {
  const n = Math.floor(Number(raw) || 24)
  return Math.max(1, Math.min(100, n))
}

function pluginPage(raw: unknown): number {
  const n = Math.floor(Number(raw) || 1)
  return Math.max(1, n)
}

function trimBase(raw: string): string {
  return String(raw || '').replace(/\/$/, '')
}

export function installPlanUrl(apiBase: string, owner: string, name: string): string {
  const ref = parsePluginRef(owner, name)
  return `${trimBase(apiBase)}/api/v1/plugins/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.name)}/install-plan`
}

export function pluginCategoriesUrl(apiBase: string): string {
  return `${trimBase(apiBase)}/api/v1/plugins/categories`
}

export function sanitizePluginAvatarUrl(raw: unknown): string {
  const url = String(raw || '').trim()
  if (!/^https:\/\//i.test(url) || url.length > 500 || /[\s<>"'`]/.test(url)) return ''
  return url
}

export function buildPluginsUrl(apiBase: string, query: PluginListQuery = {}): string {
  const params = new URLSearchParams()
  const q = String(query.q || '').trim()
  if (q) params.set('q', q)
  params.set('scope', sanitizePluginScope(query.scope))
  params.set('sort', sanitizePluginSort(query.sort))
  const category = parsePluginCategory(query.category)
  if (category) params.set('category', category)
  params.set('page', String(pluginPage(query.page)))
  params.set('page_size', String(pluginPageSize(query.pageSize)))
  return `${trimBase(apiBase)}/api/v1/plugins?${params.toString()}`
}

export function mapMarketPlugin(raw: unknown): MarketPlugin | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  try {
    const ref = parsePluginRef(r.owner, r.name)
    const repo = String(r.repositoryUrl || '')
    return {
      owner: ref.owner,
      name: ref.name,
      fullName: String(r.fullName || ref.fullName).slice(0, 200),
      description: String(r.description || '').slice(0, 500),
      stars: Number(r.stars) || 0,
      categoryKey: parsePluginCategory(r.categoryKey) || '',
      installability: r.installability === 'verified' ? 'verified' : 'unsupported',
      repositoryUrl: /^https:\/\/github\.com\//i.test(repo) ? repo.slice(0, 300) : '',
      avatarUrl: sanitizePluginAvatarUrl(r.avatarUrl),
    }
  } catch {
    return null
  }
}

const GITHUB_PIN = /^github:([A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100})#([0-9a-f]{7,40})$/i

export interface InstallPlan {
  source: string
  command?: string
  profile?: string
  plugin?: {
    fullName?: string
    headSha?: string
    repositoryUrl?: string
  }
}

export interface PluginInstallResult {
  fullName: string
  source: string
  restartedHint: boolean
  log: string
}

export interface PluginInstallDeps {
  fetchJson: typeof fetchJson
  runDshPlugin: PluginRunner
}

let installChain = Promise.resolve()

export function withPluginInstallLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = installChain.then(fn, fn)
  installChain = run.then(() => undefined, () => undefined)
  return run
}

export function resolveInstallSource(
  raw: unknown,
  expected: { owner: string; name: string; fullName: string },
): string {
  if (!raw || typeof raw !== 'object') throw new Error('安装计划无效')
  const plan = raw as Record<string, unknown>
  const command = String(plan.command || '')
  if (/(?:^|\s)--force(?:\s|$)/.test(command) || /(?:^|\s)-f(?:\s|$)/.test(command)) {
    throw new Error('拒绝带 --force 的安装计划')
  }
  const profile = String(plan.profile || 'web').trim() || 'web'
  if (profile !== 'web') throw new Error('仅支持 web profile')
  let source = String(plan.source || '').trim()
  if (!source) {
    const matched = /^dsh plugin --profile web add (\S+)$/.exec(command.trim())
    if (!matched) throw new Error('安装计划没有可用的 source')
    source = matched[1]
  }
  const pin = GITHUB_PIN.exec(source)
  if (!pin) throw new Error('安装计划 source 不是 pinned github 规格')
  const repo = pin[1]
  const sha = pin[2]
  const expectedRepo = `${expected.owner}/${expected.name}`
  if (repo.toLowerCase() !== expectedRepo.toLowerCase()) {
    throw new Error('安装计划仓库与所选插件不一致')
  }
  const plugin = plan.plugin && typeof plan.plugin === 'object' ? plan.plugin as Record<string, unknown> : {}
  const fullName = String(plugin.fullName || '').trim()
  if (fullName && fullName.toLowerCase() !== expectedRepo.toLowerCase() && fullName.toLowerCase() !== expected.fullName.toLowerCase()) {
    throw new Error('安装计划 fullName 与所选插件不一致')
  }
  const headSha = String(plugin.headSha || '').trim()
  if (headSha && headSha.toLowerCase() !== sha.toLowerCase()) {
    const a = headSha.toLowerCase()
    const b = sha.toLowerCase()
    if (!a.startsWith(b) && !b.startsWith(a)) throw new Error('安装计划 commit 与 source 不一致')
  }
  const repoUrl = String(plugin.repositoryUrl || '').trim()
  if (repoUrl) {
    const ok = new RegExp(
      `^https://github\\.com/${escapeRegExp(expected.owner)}/${escapeRegExp(expected.name)}(?:\\.git)?/?$`,
      'i',
    ).test(repoUrl)
    if (!ok) throw new Error('安装计划仓库地址与所选插件不一致')
  }
  return source
}

export async function fetchInstallPlan(
  cfg: PluginConfig,
  owner: unknown,
  name: unknown,
  fetchJsonImpl: typeof fetchJson = fetchJson,
): Promise<unknown> {
  const ref = parsePluginRef(owner, name)
  return fetchJsonImpl(installPlanUrl(cfg.apiBase, ref.owner, ref.name), fetchOpts(cfg))
}

export async function installMarketPlugin(
  plugin: { owner: unknown; name: unknown; fullName?: unknown },
  cfg: PluginConfig,
  deps: Partial<PluginInstallDeps> = {},
): Promise<PluginInstallResult> {
  const fetchImpl = deps.fetchJson ?? fetchJson
  const ref = parsePluginRef(plugin.owner, plugin.name)
  const plan = await fetchInstallPlan(cfg, ref.owner, ref.name, fetchImpl)
  const source = resolveInstallSource(plan, ref)
  const log = await addDshPlugin(source, deps.runDshPlugin ? { runDshPlugin: deps.runDshPlugin } : {})
  return {
    fullName: ref.fullName,
    source,
    restartedHint: true,
    log: log.slice(-4000),
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function fallbackPluginCategories(): PluginCategory[] {
  return PLUGIN_CATEGORY_KEYS.map((key) => ({ key, displayName: PLUGIN_CATEGORIES[key] }))
}

export function mapPluginCategory(raw: unknown): PluginCategory | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const key = parsePluginCategory(r.key)
  if (!key) return null
  const displayName = String(r.displayName || PLUGIN_CATEGORIES[key] || key).trim().slice(0, 40)
  return { key, displayName: displayName || PLUGIN_CATEGORIES[key] }
}

export async function listPluginCategories(
  cfg: PluginConfig,
  fetchJsonImpl: typeof fetchJson = fetchJson,
): Promise<PluginCategory[]> {
  const url = pluginCategoriesUrl(cfg.apiBase)
  try {
    const body = await fetchJsonImpl<{ items?: unknown[] }>(url, fetchOpts(cfg))
    const items = (Array.isArray(body.items) ? body.items : []).map(mapPluginCategory).filter((it): it is PluginCategory => !!it)
    return items.length ? items : fallbackPluginCategories()
  } catch {
    return fallbackPluginCategories()
  }
}

export async function listPlugins(
  cfg: PluginConfig,
  query: PluginListQuery = {},
  fetchJsonImpl: typeof fetchJson = fetchJson,
): Promise<PluginPage> {
  const url = buildPluginsUrl(cfg.apiBase, query)
  const body = await fetchJsonImpl<{ items?: unknown[]; total?: unknown; page?: unknown; pageSize?: unknown }>(
    url,
    fetchOpts(cfg),
  )
  const items = (Array.isArray(body.items) ? body.items : []).map(mapMarketPlugin).filter((it): it is MarketPlugin => !!it)
  return {
    items,
    total: Number(body.total) || items.length,
    page: Number(body.page) || pluginPage(query.page),
    pageSize: Number(body.pageSize) || pluginPageSize(query.pageSize),
    apiBase: trimBase(cfg.apiBase),
    webBase: trimBase(cfg.webBase),
  }
}
