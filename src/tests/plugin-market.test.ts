import assert from 'node:assert/strict'
import test from 'node:test'
import { withDefaults } from '../config-store.js'
import {
  buildPluginsUrl,
  fetchInstallPlan,
  fallbackPluginCategories,
  installMarketPlugin,
  installPlanUrl,
  listPluginCategories,
  listPlugins,
  mapMarketPlugin,
  mapPluginCategory,
  parsePluginCategory,
  parsePluginRef,
  pluginCategoriesUrl,
  resolveInstallSource,
  sanitizePluginAvatarUrl,
  sanitizePluginScope,
  sanitizePluginSort,
  withPluginInstallLock,
} from '../plugin-market.js'

test('parsePluginRef accepts GitHub owner/name', () => {
  assert.deepEqual(parsePluginRef('cocofhu', 'skillhub'), { owner: 'cocofhu', name: 'skillhub', fullName: 'cocofhu/skillhub' })
  assert.throws(() => parsePluginRef('../x', 'n'), /无效插件 owner/)
  assert.throws(() => parsePluginRef('o', 'a/b'), /无效插件 name/)
})

test('sanitizePluginScope and sort default safely', () => {
  assert.equal(sanitizePluginScope('all'), 'all')
  assert.equal(sanitizePluginScope('nope'), 'verified')
  assert.equal(sanitizePluginSort('updated'), 'updated')
  assert.equal(sanitizePluginSort('trending'), 'stars')
})

test('parsePluginCategory only accepts plugin keys, not skill keys', () => {
  assert.equal(parsePluginCategory('web-tools'), 'web-tools')
  assert.equal(parsePluginCategory('fun-dressup'), 'fun-dressup')
  assert.equal(parsePluginCategory('office-efficiency'), undefined)
  assert.equal(parsePluginCategory('ai-agent'), undefined)
  assert.equal(parsePluginCategory(''), undefined)
})

test('buildPluginsUrl forwards filters to /api/v1/plugins', () => {
  const url = buildPluginsUrl('https://api.skillhub.cn/', {
    q: 'sidebar',
    scope: 'all',
    category: 'web-tools',
    sort: 'updated',
    page: 2,
    pageSize: 24,
  })
  assert.match(url, /^https:\/\/api\.skillhub\.cn\/api\/v1\/plugins\?/)
  assert.match(url, /q=sidebar/)
  assert.match(url, /scope=all/)
  assert.match(url, /category=web-tools/)
  assert.match(url, /sort=updated/)
  assert.match(url, /page=2/)
  assert.match(url, /page_size=24/)
})

test('buildPluginsUrl omits blank query, unknown category, and skill category keys', () => {
  const url = buildPluginsUrl('https://api.skillhub.cn', { q: '  ', category: 'office-efficiency', scope: 'verified' })
  assert.doesNotMatch(url, /[?&]q=/)
  assert.doesNotMatch(url, /category=/)
  assert.match(url, /scope=verified/)
  assert.match(url, /sort=stars/)
})

test('mapMarketPlugin keeps verified plugins and drops bad refs', () => {
  const ok = mapMarketPlugin({
    owner: 'liustack',
    name: 'modlens',
    fullName: 'liustack/modlens',
    description: 'vision plugin',
    stars: 12,
    categoryKey: 'web-tools',
    installability: 'verified',
    repositoryUrl: 'https://github.com/liustack/modlens',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  })
  assert.equal(ok?.installability, 'verified')
  assert.equal(ok?.categoryKey, 'web-tools')
  assert.equal(ok?.repositoryUrl, 'https://github.com/liustack/modlens')
  assert.equal(ok?.avatarUrl, 'https://avatars.githubusercontent.com/u/1?v=4')
  assert.equal(mapMarketPlugin({ owner: '../x', name: 'n' }), null)
  assert.equal(mapMarketPlugin({ owner: 'o', name: 'n', installability: 'candidate' })?.installability, 'unsupported')
  assert.equal(mapMarketPlugin({
    owner: 'o',
    name: 'n',
    categoryKey: 'office-efficiency',
    repositoryUrl: 'https://github.com/o/n',
    avatarUrl: 'http://insecure.example/a.png',
  })?.categoryKey, '')
  assert.equal(mapMarketPlugin({
    owner: 'o',
    name: 'n',
    avatarUrl: 'javascript:alert(1)',
  })?.avatarUrl, '')
})

test('resolveInstallSource accepts pinned github plan', () => {
  const sha = 'cb481974e1154afffd3835689284d3d28e57c7e1'
  const source = resolveInstallSource({
    command: `dsh plugin --profile web add github:liustack/modlens#${sha}`,
    plugin: {
      fullName: 'liustack/modlens',
      headSha: sha,
      repositoryUrl: 'https://github.com/liustack/modlens',
    },
    profile: 'web',
    source: `github:liustack/modlens#${sha}`,
  }, { owner: 'liustack', name: 'modlens', fullName: 'liustack/modlens' })
  assert.equal(source, `github:liustack/modlens#${sha}`)
})

test('resolveInstallSource is case-insensitive for GitHub names', () => {
  const sha = '1f93efe85360560e3da49726d7a55af659e771fe'
  const source = resolveInstallSource({
    source: `github:ccch1mneyyy/dsh-tui#${sha}`,
    plugin: { fullName: 'ccch1mneyyy/dsh-tui', headSha: sha, repositoryUrl: 'https://github.com/ccch1mneyyy/dsh-TUI' },
  }, { owner: 'ccch1mneyyy', name: 'dsh-TUI', fullName: 'ccch1mneyyy/dsh-TUI' })
  assert.equal(source, `github:ccch1mneyyy/dsh-tui#${sha}`)
})

test('resolveInstallSource accepts .git URLs and short SHA prefixes', () => {
  const sha = 'abcdef0'
  const expected = { owner: 'o', name: 'n', fullName: 'o/n' }
  assert.equal(resolveInstallSource({
    source: `github:o/n#${sha}`,
    plugin: { headSha: 'abcdef0123456789', repositoryUrl: 'https://github.com/o/n.git/' },
  }, expected), `github:o/n#${sha}`)
  assert.throws(() => resolveInstallSource({ source: `github:o/n#${sha}`, command: 'dsh plugin add -f pkg' }, expected), /-f|--force/)
})

test('resolveInstallSource can parse command when source is missing', () => {
  const sha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  const source = resolveInstallSource({
    command: `dsh plugin --profile web add github:o/n#${sha}`,
  }, { owner: 'o', name: 'n', fullName: 'o/n' })
  assert.equal(source, `github:o/n#${sha}`)
})

test('resolveInstallSource rejects force, other profile, and mismatched repo', () => {
  const sha = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
  const expected = { owner: 'o', name: 'n', fullName: 'o/n' }
  assert.throws(() => resolveInstallSource(null, expected), /安装计划无效/)
  assert.throws(() => resolveInstallSource({ source: `github:o/n#${sha}`, command: 'dsh plugin --profile web add --force github:o/n' }, expected), /--force/)
  assert.throws(() => resolveInstallSource({ source: `github:o/n#${sha}`, profile: 'desktop' }, expected), /web profile/)
  assert.throws(() => resolveInstallSource({ source: `github:evil/n#${sha}` }, expected), /仓库与所选插件不一致/)
  assert.throws(() => resolveInstallSource({ source: `github:o/n#${sha}`, plugin: { fullName: 'evil/n' } }, expected), /fullName/)
  assert.throws(() => resolveInstallSource({
    source: `github:o/n#${sha}`,
    plugin: { headSha: 'cccccccccccccccccccccccccccccccccccccccc' },
  }, expected), /commit/)
  assert.throws(() => resolveInstallSource({
    source: `github:o/n#${sha}`,
    plugin: { repositoryUrl: 'https://github.com/evil/n' },
  }, expected), /仓库地址/)
  assert.throws(() => resolveInstallSource({ command: 'echo hi' }, expected), /没有可用的 source/)
  assert.throws(() => resolveInstallSource({ source: 'npm:left-pad' }, expected), /pinned github/)
})

test('installMarketPlugin fetches the plan then runs dsh plugin add', async () => {
  const cfg = withDefaults({ apiBase: 'https://api.skillhub.cn' })
  const sha = 'dddddddddddddddddddddddddddddddddddddddd'
  let seenUrl = ''
  const seen: string[][] = []
  const result = await installMarketPlugin({ owner: 'liustack', name: 'modlens' }, cfg, {
    fetchJson: async <T>(url: string) => {
      seenUrl = url
      return {
        source: `github:liustack/modlens#${sha}`,
        plugin: { fullName: 'liustack/modlens', headSha: sha, repositoryUrl: 'https://github.com/liustack/modlens' },
        command: `dsh plugin --profile web add github:liustack/modlens#${sha}`,
        profile: 'web',
      } as T
    },
    runDshPlugin: async (profile, args) => {
      seen.push([profile, ...args])
      return 'installed ok'
    },
  })
  assert.equal(seenUrl, 'https://api.skillhub.cn/api/v1/plugins/liustack/modlens/install-plan')
  assert.deepEqual(seen, [['web', 'add', `github:liustack/modlens#${sha}`]])
  assert.equal(result.restartedHint, true)
  assert.equal(result.source, `github:liustack/modlens#${sha}`)
})

test('fetchInstallPlan hits install-plan URL', async () => {
  const cfg = withDefaults({ apiBase: 'https://api.skillhub.cn/' })
  const body = await fetchInstallPlan(cfg, 'o', 'n', async <T>(url: string) => {
    assert.equal(url, 'https://api.skillhub.cn/api/v1/plugins/o/n/install-plan')
    return { source: 'github:o/n#abcdef0' } as T
  })
  assert.equal((body as { source: string }).source, 'github:o/n#abcdef0')
})

test('withPluginInstallLock runs installs one at a time', async () => {
  const order: string[] = []
  const first = withPluginInstallLock(async () => {
    await new Promise((r) => setTimeout(r, 30))
    order.push('a')
    return 1
  })
  const second = withPluginInstallLock(async () => {
    order.push('b')
    return 2
  })
  assert.deepEqual(await Promise.all([first, second]), [1, 2])
  assert.deepEqual(order, ['a', 'b'])
  const failed = withPluginInstallLock(async () => {
    throw new Error('nope')
  })
  const afterFail = withPluginInstallLock(async () => 'ok')
  await assert.rejects(failed, /nope/)
  assert.equal(await afterFail, 'ok')
})

test('installMarketPlugin does not spawn when the plan is for another repo', async () => {
  const cfg = withDefaults({ apiBase: 'https://api.skillhub.cn' })
  await assert.rejects(
    () => installMarketPlugin({ owner: 'o', name: 'n' }, cfg, {
      fetchJson: async <T>() => ({ source: 'github:evil/n#abcdef0' }) as T,
      runDshPlugin: async () => {
        throw new Error('should not run')
      },
    }),
    /仓库与所选插件不一致/,
  )
})

test('installPlanUrl encodes owner/name', () => {
  assert.equal(
    installPlanUrl('https://api.skillhub.cn', 'o', 'n'),
    'https://api.skillhub.cn/api/v1/plugins/o/n/install-plan',
  )
})

test('sanitizePluginAvatarUrl keeps https images and drops junk', () => {
  assert.equal(sanitizePluginAvatarUrl('https://cdn.example/a.png'), 'https://cdn.example/a.png')
  assert.equal(sanitizePluginAvatarUrl('http://cdn.example/a.png'), '')
  assert.equal(sanitizePluginAvatarUrl('javascript:alert(1)'), '')
  assert.equal(sanitizePluginAvatarUrl('https://x.example/a.png "onload='), '')
})

test('listPlugins maps catalog payload and returns webBase', async () => {
  const cfg = withDefaults({ apiBase: 'https://api.skillhub.cn', webBase: 'https://skillhub.cn' })
  let seen = ''
  const page = await listPlugins(cfg, { q: 'mod', scope: 'verified', pageSize: 24 }, async <T>(url: string) => {
    seen = url
    return {
      total: 1,
      page: 1,
      pageSize: 24,
      items: [{
        owner: 'liustack',
        name: 'modlens',
        fullName: 'liustack/modlens',
        description: 'vision',
        stars: 10,
        categoryKey: 'web-tools',
        installability: 'verified',
        repositoryUrl: 'https://github.com/liustack/modlens',
        avatarUrl: 'https://cdn.example/modlens.png',
      }],
    } as T
  })
  assert.match(seen, /https:\/\/api\.skillhub\.cn\/api\/v1\/plugins\?/)
  assert.match(seen, /q=mod/)
  assert.match(seen, /scope=verified/)
  assert.match(seen, /page_size=24/)
  assert.equal(page.total, 1)
  assert.equal(page.webBase, 'https://skillhub.cn')
  assert.equal(page.apiBase, 'https://api.skillhub.cn')
  assert.equal(page.items[0].name, 'modlens')
  assert.equal(page.items[0].avatarUrl, 'https://cdn.example/modlens.png')
})

test('pluginCategoriesUrl hits /api/v1/plugins/categories', () => {
  assert.equal(pluginCategoriesUrl('https://api.skillhub.cn/'), 'https://api.skillhub.cn/api/v1/plugins/categories')
})

test('mapPluginCategory drops skill keys', () => {
  assert.deepEqual(mapPluginCategory({ key: 'memory', displayName: '记忆' }), { key: 'memory', displayName: '记忆' })
  assert.equal(mapPluginCategory({ key: 'office-efficiency', displayName: '办公效率' }), null)
  assert.equal(fallbackPluginCategories().length, 7)
  assert.equal(fallbackPluginCategories()[0].key, 'fun-dressup')
})

test('listPluginCategories uses catalog payload and falls back', async () => {
  const cfg = withDefaults({ apiBase: 'https://api.skillhub.cn' })
  const items = await listPluginCategories(cfg, async <T>(url: string) => {
    assert.equal(url, 'https://api.skillhub.cn/api/v1/plugins/categories')
    return { items: [{ key: 'web-tools', displayName: '联网工具' }, { key: 'office-efficiency', displayName: 'nope' }] } as T
  })
  assert.deepEqual(items, [{ key: 'web-tools', displayName: '联网工具' }])
  const fallback = await listPluginCategories(cfg, async () => {
    throw new Error('offline')
  })
  assert.equal(fallback.length, 7)
})
