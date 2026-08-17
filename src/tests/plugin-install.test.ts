import assert from 'node:assert/strict'
import test from 'node:test'
import { withDefaults } from '../config-store.js'
import {
  assertVerifiedInstallability,
  buildPluginAddArgs,
  installMarketPlugin,
  resolveInstallPlan,
} from '../plugin-install.js'

test('assertVerifiedInstallability only allows verified', () => {
  assert.doesNotThrow(() => assertVerifiedInstallability('verified'))
  assert.throws(() => assertVerifiedInstallability('unsupported'), /verified/)
  assert.throws(() => assertVerifiedInstallability(undefined), /verified/)
})

test('resolveInstallPlan requires profile and source/command', () => {
  assert.throws(() => resolveInstallPlan(null), /无效/)
  assert.throws(() => resolveInstallPlan({ source: 'github:o/n#abc' }), /profile/)
  assert.throws(() => resolveInstallPlan({ profile: 'web' }), /source\/command/)
  const ok = resolveInstallPlan({
    command: 'dsh plugin --profile web add github:liustack/modlens#deadbeef',
    source: 'github:liustack/modlens#deadbeef',
    profile: 'web',
  })
  assert.equal(ok.profile, 'web')
  assert.equal(ok.source, 'github:liustack/modlens#deadbeef')
  assert.match(ok.command, /plugin/)
})

test('resolveInstallPlan parses source from command when source missing', () => {
  const ok = resolveInstallPlan({
    command: 'dsh plugin --profile web add github:o/n#abc1234',
    profile: 'web',
  })
  assert.equal(ok.source, 'github:o/n#abc1234')
})

test('buildPluginAddArgs pins profile and source', () => {
  assert.deepEqual(
    buildPluginAddArgs('web', 'github:o/n#sha'),
    ['--yes', '@deepseek-ai/dsh', 'plugin', '--profile', 'web', 'add', 'github:o/n#sha'],
  )
})

test('installMarketPlugin rejects non-verified without spawn or install-plan', async () => {
  let fetched = false
  let spawned = false
  let restarts = 0
  const result = await installMarketPlugin(
    withDefaults({}),
    { owner: 'o', name: 'n', installability: 'unsupported' },
    {
      fetchJson: async <T>() => {
        fetched = true
        return {} as T
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
  assert.equal(fetched, false)
  assert.equal(spawned, false)
  assert.equal(restarts, 0)
  assert.match(result.error || '', /verified/)
})

test('installMarketPlugin fails when install-plan lacks fields and does not spawn', async () => {
  let spawned = false
  let restarts = 0
  const result = await installMarketPlugin(
    withDefaults({}),
    { owner: 'cocofhu', name: 'skillhub', installability: 'verified' },
    {
      fetchJson: async <T>() => ({ profile: 'web' }) as T,
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

test('installMarketPlugin runs pinned plugin add and SIGTERM on success', async () => {
  const seen: string[][] = []
  let restarts = 0
  const source = 'github:liustack/modlens#abcdef0123456789'
  const result = await installMarketPlugin(
    withDefaults({}),
    { owner: 'liustack', name: 'modlens', fullName: 'liustack/modlens', installability: 'verified' },
    {
      fetchJson: async <T>() => ({
        command: `dsh plugin --profile web add ${source}`,
        source,
        profile: 'web',
      }) as T,
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
  assert.deepEqual(seen[0].slice(-4), ['--profile', 'web', 'add', source])
  assert.match(result.message, /自动重启|SIGTERM|supervisor|KeepAlive/)
})

test('installMarketPlugin surfaces stderr and does not SIGTERM on failure', async () => {
  let restarts = 0
  const result = await installMarketPlugin(
    withDefaults({}),
    { owner: 'liustack', name: 'modlens', installability: 'verified' },
    {
      fetchJson: async <T>() => ({
        command: 'dsh plugin --profile web add github:liustack/modlens#sha',
        source: 'github:liustack/modlens#sha',
        profile: 'web',
      }) as T,
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
    withDefaults({}),
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
  assert.equal(result.phase, 'install-plan')
  assert.match(result.error || '', /502/)
  assert.doesNotMatch(result.message, /prompt|session/i)
})
