import assert from 'node:assert/strict'
import test from 'node:test'
import { withDefaults } from '../config-store.js'
import {
  assertPinnedGithubSource,
  assertPlanPluginIdentity,
  assertSafeInstallApiBase,
  assertVerifiedInstallability,
  buildPluginAddArgs,
  installMarketPlugin,
  resolveInstallPlan,
} from '../plugin-install.js'
import type { PluginInstallDeps } from '../plugin-install.js'

const SHA = 'abcdef0123456789abcdef0123456789abcdef01'
const PINNED = `github:liustack/modlens#${SHA}`
const OFFICIAL = withDefaults({})

function catalogAndPlan(
  catalog: unknown,
  plan: unknown,
): PluginInstallDeps['fetchJson'] {
  return async <T>(url: string): Promise<T> => {
    if (String(url).includes('/install-plan')) return plan as T
    return catalog as T
  }
}

function verifiedPlugin(owner = 'liustack', name = 'modlens') {
  return { owner, name, fullName: `${owner}/${name}`, installability: 'verified', description: '', stars: 1 }
}

function pinnedPlan(owner = 'liustack', name = 'modlens', sha = SHA) {
  const source = `github:${owner}/${name}#${sha}`
  return {
    command: `dsh plugin --profile web add ${source}`,
    source,
    profile: 'web',
    plugin: { fullName: `${owner}/${name}`, headSha: sha },
  }
}

test('assertVerifiedInstallability only allows verified', () => {
  assert.doesNotThrow(() => assertVerifiedInstallability('verified'))
  assert.throws(() => assertVerifiedInstallability('unsupported'), /verified/)
  assert.throws(() => assertVerifiedInstallability(undefined), /verified/)
})

test('assertSafeInstallApiBase requires https official host unless allowlisted', () => {
  assert.doesNotThrow(() => assertSafeInstallApiBase('https://api.skillhub.cn'))
  assert.throws(() => assertSafeInstallApiBase('http://api.skillhub.cn'), /https/)
  assert.throws(() => assertSafeInstallApiBase('https://evil.example'), /官方 API|SKILLHUB_ALLOW_CUSTOM_API_BASE/)
  const prev = process.env.SKILLHUB_ALLOW_CUSTOM_API_BASE
  process.env.SKILLHUB_ALLOW_CUSTOM_API_BASE = '1'
  try {
    assert.doesNotThrow(() => assertSafeInstallApiBase('https://evil.example'))
  } finally {
    if (prev === undefined) delete process.env.SKILLHUB_ALLOW_CUSTOM_API_BASE
    else process.env.SKILLHUB_ALLOW_CUSTOM_API_BASE = prev
  }
})

test('assertPinnedGithubSource rejects file/link/http/floating refs and short sha', () => {
  assert.equal(
    assertPinnedGithubSource(`github:o/n#${SHA}`, { owner: 'o', name: 'n' }),
    `github:o/n#${SHA}`,
  )
  assert.throws(() => assertPinnedGithubSource('file:/tmp/x'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('link:foo'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('https://example.com/pkg.tgz'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('/abs/path'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('github:o/n'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('github:o/n#main'), /commit-pinned|拒绝/)
  assert.throws(() => assertPinnedGithubSource('github:o/n#abcdef0'), /40-hex|短 SHA|拒绝/)
  assert.throws(() => assertPinnedGithubSource(`github:o/n#${SHA}`, { owner: 'other', name: 'n' }), /不一致/)
})

test('resolveInstallPlan requires profile and commit-pinned source/command', () => {
  assert.throws(() => resolveInstallPlan(null), /无效/)
  assert.throws(() => resolveInstallPlan({ source: `github:o/n#${SHA}` }), /profile/)
  assert.throws(() => resolveInstallPlan({ profile: 'web' }), /source\/command/)
  assert.throws(() => resolveInstallPlan({ profile: '..', source: `github:o/n#${SHA}` }), /profile/)
  assert.throws(
    () => resolveInstallPlan({ profile: 'web', source: 'github:o/n#main' }),
    /commit-pinned|拒绝/,
  )
  const ok = resolveInstallPlan(pinnedPlan(), { owner: 'liustack', name: 'modlens' })
  assert.equal(ok.profile, 'web')
  assert.equal(ok.source, PINNED)
  assert.match(ok.command, /plugin/)
})

test('resolveInstallPlan parses source from command when source missing', () => {
  const ok = resolveInstallPlan(
    {
      command: `dsh plugin --profile web add github:o/n#${SHA}`,
      profile: 'web',
    },
    { owner: 'o', name: 'n' },
  )
  assert.equal(ok.source, `github:o/n#${SHA}`)
})

test('assertPlanPluginIdentity rejects headSha / fullName mismatch', () => {
  assert.throws(
    () => assertPlanPluginIdentity(
      { plugin: { fullName: 'other/n', headSha: SHA } },
      { owner: 'o', name: 'n' },
      `github:o/n#${SHA}`,
    ),
    /fullName/,
  )
  assert.throws(
    () => assertPlanPluginIdentity(
      { plugin: { fullName: 'o/n', headSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } },
      { owner: 'o', name: 'n' },
      `github:o/n#${SHA}`,
    ),
    /headSha/,
  )
})

test('buildPluginAddArgs pins profile and source', () => {
  assert.deepEqual(
    buildPluginAddArgs('web', 'github:o/n#abcdef0123456789'),
    ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', 'github:o/n#abcdef0123456789'],
  )
})

test('installMarketPlugin rejects upstream non-verified even if client claims verified', async () => {
  let planFetched = false
  let spawned = false
  let restarts = 0
  const seenUrls: string[] = []
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'o', name: 'n', installability: 'verified' },
    {
      fetchJson: async <T>(url: string): Promise<T> => {
        seenUrls.push(String(url))
        if (String(url).includes('/install-plan')) {
          planFetched = true
          return {} as T
        }
        return {
          owner: 'o',
          name: 'n',
          installability: 'unsupported',
        } as T
      },
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => { restarts += 1 },
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(planFetched, false)
  assert.equal(spawned, false)
  assert.equal(restarts, 0)
  assert.match(result.error || '', /verified/)
  assert.match(seenUrls[0] || '', /\/api\/v1\/plugins\/o\/n$/)
  assert.doesNotMatch(seenUrls.join('\n'), /[?&]q=/)
})

test('installMarketPlugin rejects missing catalog hit without spawn', async () => {
  let planFetched = false
  let spawned = false
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'missing', name: 'plugin', installability: 'verified' },
    {
      fetchJson: async <T>(url: string): Promise<T> => {
        if (String(url).includes('/install-plan')) {
          planFetched = true
          return {} as T
        }
        return {} as T
      },
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(planFetched, false)
  assert.equal(spawned, false)
  assert.match(result.error || '', /verified/)
})

test('installMarketPlugin fails when install-plan lacks fields and does not spawn', async () => {
  let spawned = false
  let restarts = 0
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'cocofhu', name: 'skillhub', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin('cocofhu', 'skillhub'), { profile: 'web' }),
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => { restarts += 1 },
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'install-plan')
  assert.equal(spawned, false)
  assert.equal(restarts, 0)
  assert.match(result.error || '', /source\/command/)
})

test('installMarketPlugin rejects floating branch source and does not spawn', async () => {
  let spawned = false
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), {
        profile: 'web',
        source: 'github:liustack/modlens#main',
        command: 'dsh plugin --profile web add github:liustack/modlens#main',
      }),
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'install-plan')
  assert.equal(spawned, false)
  assert.match(result.error || '', /commit-pinned|拒绝/)
})

test('installMarketPlugin rejects file: source and does not spawn', async () => {
  let spawned = false
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), {
        profile: 'web',
        source: 'file:/tmp/evil',
        command: 'dsh plugin --profile web add file:/tmp/evil',
      }),
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(spawned, false)
  assert.match(result.error || '', /commit-pinned|拒绝/)
})

test('installMarketPlugin runs pinned plugin add and SIGTERM on success', async () => {
  const seen: string[][] = []
  let restarts = 0
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', fullName: 'liustack/modlens', installability: 'unsupported' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), pinnedPlan()),
      runCommand: async (cmd, args) => {
        seen.push([cmd, ...args])
        return 'installed ok'
      },
      profileDir: (profile) => `/tmp/profiles/${profile}`,
      requestRestart: () => { restarts += 1 },
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, true)
  assert.equal(result.autoRestartRequested, true)
  assert.equal(result.phase, 'auto-restart')
  assert.equal(restarts, 1)
  assert.equal(seen.length, 1)
  assert.equal(seen[0][0], 'npx')
  assert.deepEqual(seen[0].slice(-4), ['--profile', 'web', 'add', PINNED])
  assert.match(result.message, /自动重启|SIGTERM|supervisor|KeepAlive/)
})

test('installMarketPlugin surfaces stderr and does not SIGTERM on failure', async () => {
  let restarts = 0
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), pinnedPlan()),
      runCommand: async () => {
        throw new Error('命令失败 (exit 1): Ignored build scripts: allowBuilds')
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => { restarts += 1 },
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'plugin-add')
  assert.equal(result.autoRestartRequested, false)
  assert.equal(restarts, 0)
  assert.match(result.error || '', /allowBuilds/)
})

test('installMarketPlugin does not fall back to prompt on network failure', async () => {
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'o', name: 'n', installability: 'verified' },
    {
      fetchJson: async <T>(): Promise<T> => {
        throw new Error('HTTP 502 upstream')
      },
      runCommand: async () => {
        throw new Error('should not run')
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {
        throw new Error('should not restart')
      },
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'failed')
  assert.match(result.error || '', /502/)
  assert.doesNotMatch(result.message, /prompt|session/i)
})

test('installMarketPlugin rejects non-official apiBase without allow env', async () => {
  let fetched = false
  const result = await installMarketPlugin(
    withDefaults({ apiBase: 'https://evil.example' }),
    { owner: 'o', name: 'n', installability: 'verified' },
    {
      fetchJson: async <T>(): Promise<T> => {
        fetched = true
        return {} as T
      },
      runCommand: async () => '',
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(fetched, false)
  assert.match(result.error || '', /官方 API|SKILLHUB_ALLOW_CUSTOM_API_BASE/)
})

test('installMarketPlugin rejects abbreviated sha and does not spawn', async () => {
  let spawned = false
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), {
        profile: 'web',
        source: 'github:liustack/modlens#abcdef0',
        command: 'dsh plugin --profile web add github:liustack/modlens#abcdef0',
      }),
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'install-plan')
  assert.equal(spawned, false)
  assert.match(result.error || '', /40-hex|短 SHA|拒绝/)
})

test('installMarketPlugin rejects headSha mismatch and does not spawn', async () => {
  let spawned = false
  const result = await installMarketPlugin(
    OFFICIAL,
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: catalogAndPlan(verifiedPlugin(), {
        ...pinnedPlan(),
        plugin: { fullName: 'liustack/modlens', headSha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      }),
      runCommand: async () => {
        spawned = true
        return ''
      },
      profileDir: () => '/tmp/profile-web',
      requestRestart: () => {},
      scheduleRestart: (fn) => fn(),
    },
  )
  assert.equal(result.ok, false)
  assert.equal(spawned, false)
  assert.match(result.error || '', /headSha/)
})
