import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import Schema from '@deepseek-ai/schemastery'
import { fetchSkillCard, parseSlug, searchSkills } from './api.js'
import { CATEGORY_KEYS, categoryLabel, parseCategory } from './categories.js'
import { assignConfig, publicConfig, readOverlay, sanitizePatch, sanitizeSortBy, withDefaults, writeOverlay } from './config-store.js'
import { fetchBytes } from './http.js'
import { installSkill, listInstalled, uninstallSkill } from './install.js'
import { fetchEvalScore, fetchSkillTab } from './skill-detail.js'
import { getUpdateStatus, updateToLatestRelease } from './self-update.js'
import type { InstallResult, InstalledSkill, PluginConfig, SearchResult, SkillCard, SortBy } from './types.js'

export const name = 'skillhub'
export const inject = ['tools']

export interface Config extends PluginConfig {}

export const Config: Schema<Config> = Schema.object({
  apiBase: Schema.string().default('https://api.skillhub.cn').description('SkillHub API'),
  webBase: Schema.string().default('https://skillhub.cn').description('技能主页'),
  skillsDir: Schema.string().description('安装目录，默认 $DSH_HOME/skills'),
  timeoutMs: Schema.number().default(20000).description('上游请求超时（毫秒）'),
  userAgent: Schema.string().default('Mozilla/5.0 (compatible; skillhub/0.1)').description('请求 UA'),
  maxResults: Schema.number().default(12).description('搜索结果上限'),
  sortBy: Schema.union(['score', 'downloads', 'stars', 'installs', 'updated_at'] as const).default('score').description('默认排序'),
})

export function apply(ctx: Context, config: Config): void {
  const cfg = withDefaults(config)
  assignConfig(cfg, readOverlay())

  ctx.tools.register(defineTool({
    name: 'skillhub_search',
    description:
      'Search SkillHub and show clickable skill cards. ALWAYS call this instead of web_search, skill-catalog, load_skill, or bash when the user wants to find/recommend/browse skills. Call EXACTLY ONCE per user message. You extract the search topic: pass a real keyword (PDF, 周报), not the user\'s whole sentence. Omit query to browse popular skills. For 还有吗, reuse the previous query with offset = cards already shown. After cards appear, reply with AT MOST one short sentence.',
    parameters: {
      query: { type: 'string', description: 'Main keyword, e.g. PDF or 周报. Optional when category is set.' },
      queries: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional extra keywords/synonyms for this SAME call. Merged into one card group. Do not make extra skillhub_search calls.',
      },
      category: {
        type: 'string',
        description: `Optional first-level category: ${CATEGORY_KEYS.join(', ')}`,
      },
      sortBy: { type: 'string', description: 'score, downloads, stars, installs, updated_at. Default score.' },
      limit: { type: 'number', description: 'Cards in this batch. Default from config.' },
      offset: { type: 'number', description: 'Skip this many already-shown cards when the user wants more.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderSearch(value as unknown as SearchResult) }],
      presentationMeta: (_args, value) => ({ kind: 'skillhub-search', ...(value as object) }),
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SkillHub · ${String(args.query || args.category || '浏览')}`,
      kind: 'search',
      content: [],
    }),
    presentResult: (_args, { isError, meta }) => ({
      card: 'generic',
      title: isError ? 'SkillHub 搜索失败' : `SkillHub · ${(meta as SearchResult | undefined)?.items?.length ?? 0} 条`,
      content: [],
    }),
    timeoutMs: cfg.timeoutMs + 5000,
    async execute(args, exec) {
      const query = String(args.query || '').trim()
      const category = parseCategory(args.category)
      const installed = await installedSet(cfg.skillsDir)
      const explicit = Number(args.limit)
      const limit = Number.isFinite(explicit) && explicit > 0 ? clamp(explicit, 1, 80) : cfg.maxResults
      const offset = Math.max(0, Math.floor(Number(args.offset) || 0))
      const sortBy = sanitizeSortBy(args.sortBy, query ? cfg.sortBy : 'downloads') as SortBy
      return JSON.parse(JSON.stringify(await searchSkills(query, {
        cfg,
        queries: args.queries,
        category,
        sortBy,
        limit,
        offset,
        installed,
        signal: exec.signal,
      })))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_install',
    description:
      'Install a SkillHub skill into the configured skills directory after the user chooses one. Pass the slug from skillhub_search. Do not print CLI commands. After success, say the skill is installed.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Skill slug from search, e.g. pdf-ocr-md' },
      version: { type: 'string', description: 'Optional exact version such as 1.0.0. Default is latest.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderInstall(value as unknown as InstallResult) }],
      presentationMeta: (_args, value) => ({ kind: 'skillhub-install', ...(value as object) }),
    },
    presentCall: (args) => ({ card: 'generic', title: `安装 · ${args.slug}`, kind: 'search', content: [] }),
    presentResult: (_args, { isError, meta }) => ({
      card: 'generic',
      title: isError ? '安装失败' : `已安装 · ${(meta as InstallResult | undefined)?.name || ''}`,
      content: [],
    }),
    timeoutMs: cfg.timeoutMs + 15000,
    async execute(args, exec) {
      return JSON.parse(JSON.stringify(await installSkill(String(args.slug || ''), cfg, undefined, exec.signal, args.version ? String(args.version) : undefined)))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_list',
    description: 'List skills already installed in the SkillHub plugin skills directory. Use when the user asks what skills are installed or to manage local skills.',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: renderList(value as unknown as { items: InstalledSkill[]; skillsDir: string }) }],
      presentationMeta: (_args, value) => ({ kind: 'skillhub-list', ...(value as object) }),
    },
    presentCall: () => ({ card: 'generic', title: '已装技能', kind: 'search', content: [] }),
    presentResult: (_args, { isError, meta }) => ({
      card: 'generic',
      title: isError ? '列出失败' : `已装 · ${(meta as { items?: InstalledSkill[] } | undefined)?.items?.length ?? 0} 个`,
      content: [],
    }),
    async execute() {
      const items = await listInstalled(cfg.skillsDir)
      return JSON.parse(JSON.stringify({ skillsDir: cfg.skillsDir, items }))
    },
  }))

  ctx.tools.register(defineTool({
    name: 'skillhub_uninstall',
    description: 'Uninstall a locally installed skill by slug. Only removes a directory under the configured skills directory that contains SKILL.md.',
    parameters: {
      slug: { type: 'string', required: true, description: 'Installed skill directory name / slug' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: `已卸载 ${(value as { slug: string }).slug}` }],
      presentationMeta: (_args, value) => ({ kind: 'skillhub-uninstall', ...(value as object) }),
    },
    presentCall: (args) => ({ card: 'generic', title: `卸载 · ${args.slug}`, content: [] }),
    presentResult: (_args, { isError, meta }) => ({
      card: 'generic',
      title: isError ? '卸载失败' : `已卸载 · ${(meta as { slug?: string } | undefined)?.slug || ''}`,
      content: [],
    }),
    async execute(args) {
      return JSON.parse(JSON.stringify(await uninstallSkill(String(args.slug || ''), cfg.skillsDir)))
    },
  }))

  ctx.inject(['systemPrompt'], (c) => {
    const prompt = (c as unknown as {
      systemPrompt: {
        section: (section: { name: string; order: number; text: string | (() => string) }) => void
      }
    }).systemPrompt
    prompt.section({
      name: 'tool:skillhub',
      order: 210,
      text: [
        'Finding / recommending / browsing Agent Skills or SkillHub skills: you MUST call skillhub_search. Never web_search, skill-catalog, load_skill, bash, or SKILL.md dump. Never print skillhub install, curl, or sh -c.',
        'You decide the keyword. Extract a real topic from the user; do not paste their whole sentence as query. No topic / just 好玩 有趣 推荐 → omit query to browse. 还有吗 → same previous query + offset. One call per user message.',
        'Do not say 点卡片查看 unless skillhub_search has already returned cards in this turn.',
        'After cards appear, reply with AT MOST one short sentence. Do NOT list skills or write essays.',
        'Install only after the user chooses a card: skillhub_install with that slug. Then one short sentence.',
        `Categories: ${CATEGORY_KEYS.map((k) => `${k}=${categoryLabel(k)}`).join(', ')}.`,
        'For installed skills, call skillhub_list / skillhub_uninstall.',
      ].join(' '),
    })
  })

  ctx.inject(['webServer'], (c) => {
    const server = (c as unknown as { webServer: { register: (route: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }) => void } }).webServer
    server.register({ kind: 'exact', path: '/skillhub', handler: (req, res) => handleApi(req, res, cfg) })
    server.register({ kind: 'exact', path: '/skillhub/icon', handler: (req, res) => handleIcon(req, res, cfg) })
  })
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

async function installedSet(skillsDir: string): Promise<Set<string>> {
  try {
    const items = await listInstalled(skillsDir)
    return new Set(items.map((it) => it.slug))
  } catch {
    return new Set()
  }
}

export function renderSearch(result: SearchResult): string {
  if (!result.items?.length) return '没有找到相关技能。对用户只说一句：没找到，可以换个词再搜。不要写长文。'
  const lines = result.items.map((it, i) => `${i + 1}. ${it.name}${it.installed ? '（已安装）' : ''} · ${it.slug}`)
  const start = result.offset || 0
  const shown = start + result.items.length
  const more = result.hasMore
    ? `用户若问还有吗，立刻再调用 skillhub_search 一次，query 仍为「${result.query}」，offset=${shown}。`
    : '已经全部列出。'
  const note = result.fallback ? '本次是热门浏览（原关键词没有结果或没有更多）。' : ''
  return [
    `卡片已展示 ${result.items.length} 条（内部序号，禁止复述给用户）：`,
    lines.join('\n'),
    `${note}对用户最多回一句短话。禁止清单和长文。不要再调用 skillhub_search。${more}`,
  ].join('\n')
}

export function renderInstall(result: InstallResult): string {
  return `✅ ${result.name} 已安装到 ${result.path}。新对话即可被 skill 工具发现。不要打印安装命令。`
}

export function renderList(result: { items: InstalledSkill[]; skillsDir: string }): string {
  if (!result.items?.length) return `还没有安装技能。目录：${result.skillsDir}`
  const lines = result.items.map((it, i) => `${i + 1}. ${it.name} (${it.slug})${it.version ? ` v${it.version}` : ''}`)
  return `已安装 ${result.items.length} 个技能（${result.skillsDir}）：\n${lines.join('\n')}`
}

async function attachRatings(items: SkillCard[], cfg: PluginConfig): Promise<void> {
  await Promise.all(items.slice(0, 24).map(async (it) => {
    const rating = await fetchEvalScore(it.slug, cfg)
    if (rating != null) it.rating = rating
  }))
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return {}
  }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

async function handleApi(req: IncomingMessage, res: ServerResponse, cfg: PluginConfig): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const body = req.method === 'POST' ? await readBody(req) : {}
    const method = String(body.method || url.searchParams.get('method') || 'search')
    if (method === 'search') {
      const query = String(body.query || url.searchParams.get('query') || '').trim()
      const category = parseCategory(body.category || url.searchParams.get('category'))
      const explicit = Number(body.limit)
      const limit = Number.isFinite(explicit) && explicit > 0 ? clamp(explicit, 1, 80) : cfg.maxResults
      const offset = Math.max(0, Math.floor(Number(body.offset) || 0))
      const installed = await installedSet(cfg.skillsDir)
      const result = await searchSkills(query, {
        cfg,
        queries: body.queries,
        category,
        sortBy: sanitizeSortBy(body.sortBy, query ? cfg.sortBy : 'downloads'),
        limit,
        offset,
        installed,
      })
      await attachRatings(result.items, cfg)
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (method === 'install') {
      const slug = String(body.slug || url.searchParams.get('slug') || '').trim()
      if (!slug) return sendJson(res, 400, { ok: false, error: '缺少 slug' })
      const version = String(body.version || url.searchParams.get('version') || '').trim()
      const result = await installSkill(slug, cfg, undefined, undefined, version || undefined)
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (method === 'list') {
      const items = await listInstalled(cfg.skillsDir)
      return sendJson(res, 200, { ok: true, skillsDir: cfg.skillsDir, items })
    }
    if (method === 'uninstall') {
      const slug = String(body.slug || url.searchParams.get('slug') || '').trim()
      if (!slug) return sendJson(res, 400, { ok: false, error: '缺少 slug' })
      const result = await uninstallSkill(slug, cfg.skillsDir)
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (method === 'config') {
      if (body.save) {
        assignConfig(cfg, sanitizePatch(body))
        writeOverlay(cfg)
      }
      return sendJson(res, 200, { ok: true, ...publicConfig(cfg) })
    }
    if (method === 'updateCheck') {
      const status = await getUpdateStatus({ timeoutMs: Math.min(cfg.timeoutMs, 20000), userAgent: cfg.userAgent })
      return sendJson(res, 200, { ok: true, ...status })
    }
    if (method === 'update') {
      const result = await updateToLatestRelease({
        timeoutMs: Math.max(cfg.timeoutMs, 120000),
        userAgent: cfg.userAgent,
      })
      return sendJson(res, 200, { ok: true, ...result })
    }
    if (method === 'detail') {
      const slug = parseSlug(String(body.slug || url.searchParams.get('slug') || ''))
      const installed = await installedSet(cfg.skillsDir)
      const [card, rating] = await Promise.all([
        fetchSkillCard(slug, cfg, installed),
        fetchEvalScore(slug, cfg),
      ])
      if (card && rating != null) card.rating = rating
      return sendJson(res, 200, {
        ok: true,
        slug,
        installed: installed.has(slug),
        version: card?.version || '',
        card,
      })
    }
    if (method === 'skillTab') {
      const slug = parseSlug(String(body.slug || url.searchParams.get('slug') || ''))
      const tab = String(body.tab || url.searchParams.get('tab') || '').trim()
      if (!tab) return sendJson(res, 400, { ok: false, error: '缺少 tab' })
      const result = await fetchSkillTab(slug, tab, cfg)
      return sendJson(res, 200, { ok: true, slug, ...result })
    }
    sendJson(res, 400, { ok: false, error: 'unknown method' })
  } catch (err) {
    sendJson(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

async function handleIcon(req: IncomingMessage, res: ServerResponse, cfg: PluginConfig): Promise<void> {
  try {
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const target = url.searchParams.get('url') || ''
    if (!/^https:\/\//i.test(target)) {
      res.statusCode = 400
      res.end('bad url')
      return
    }
    const { body, contentType } = await fetchBytes(target, { timeoutMs: Math.min(cfg.timeoutMs, 15000), userAgent: cfg.userAgent })
    res.statusCode = 200
    res.setHeader('content-type', contentType.startsWith('image/') ? contentType : 'image/png')
    res.setHeader('cache-control', 'public, max-age=3600')
    res.end(body)
  } catch (err) {
    res.statusCode = 502
    res.end(err instanceof Error ? err.message : 'icon failed')
  }
}
