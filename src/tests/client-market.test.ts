import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

type ClientExports = {
  phaseMeta: (phase: string) => { pct: number; key: string }
  directInstallPlugin: (
    plugin: Record<string, unknown>,
    onPhase?: (phase: string) => void,
  ) => Promise<Record<string, unknown>>
}

function loadClientExports(): ClientExports {
  const src = readFileSync(join(root, 'src/client.js'), 'utf8')
  let exports: ClientExports | undefined
  const React = {
    createElement: (...args: unknown[]) => ({ type: args[0], props: args[1], children: args.slice(2) }),
    useState: (v: unknown) => [typeof v === 'function' ? (v as () => unknown)() : v, () => {}],
    useEffect: () => {},
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown) => fn,
    useRef: (v: unknown) => ({ current: v }),
    createContext: () => ({ Provider: (props: unknown) => props }),
    useContext: () => null,
  }
  const sandbox: Record<string, unknown> = {
    document: {
      baseURI: 'http://127.0.0.1:8787/',
      getElementById: () => null,
      createElement: () => ({ setAttribute() {}, sheet: { insertRule() {} }, style: {}, textContent: '' }),
      head: { appendChild() {} },
      documentElement: { lang: 'zh' },
    },
    navigator: { language: 'zh-CN' },
    location: { pathname: '/' },
    URL,
    fetch: (...args: unknown[]) => (globalThis.fetch as (...a: unknown[]) => unknown)(...args),
    console,
    setTimeout,
    clearTimeout,
  }
  sandbox.window = {
    __ModuleLoader__: {
      load(mod: { factory: (req: (id: string) => unknown) => ClientExports }) {
        exports = mod.factory((id: string) => {
          if (id === 'react') return React
          if (id === 'react-dom') return {}
          throw new Error(`unexpected require: ${id}`)
        })
      },
    },
    document: sandbox.document,
    location: sandbox.location,
    navigator: sandbox.navigator,
    fetch: sandbox.fetch,
  }
  vm.runInNewContext(src, sandbox, { filename: 'client.js' })
  assert.ok(exports)
  return exports
}

test('client marketplace install path uses pluginInstall not prompt/session', () => {
  const src = readFileSync(join(root, 'src/client.js'), 'utf8')
  assert.match(src, /pluginInstall/)
  assert.match(src, /directInstallPlugin/)
  assert.match(src, /sh-mkt-progress/)
  assert.match(src, /sh-mkt-install/)
  assert.match(src, /\.loading/)
  assert.doesNotMatch(src, /queueInstallPrompt/)
  assert.doesNotMatch(src, /session\.prompt/)
  assert.doesNotMatch(src, /mkt\.noTask/)
  assert.match(src, /inject = \["slots"\]/)
  assert.match(src, /applyPhase\("done", "ok"\)/)
  assert.doesNotMatch(src, /applyPhase\(body\.phase \|\| "auto-restart"/)
})

test('phaseMeta covers Demo progress stages', () => {
  const mod = loadClientExports()
  assert.equal(mod.phaseMeta('init').pct, 12)
  assert.equal(mod.phaseMeta('install-plan').pct, 38)
  assert.equal(mod.phaseMeta('plugin-add').pct, 72)
  assert.equal(mod.phaseMeta('auto-restart').pct, 92)
  assert.equal(mod.phaseMeta('done').pct, 100)
  assert.equal(mod.phaseMeta('failed').pct, 58)
})

test('directInstallPlugin posts pluginInstall without sessions binding', async () => {
  const mod = loadClientExports()
  const phases: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>
    assert.equal(body.method, 'pluginInstall')
    assert.equal(body.owner, 'liustack')
    assert.equal(body.name, 'modlens')
    assert.equal(body.installability, 'verified')
    assert.equal('sessions' in body, false)
    return {
      ok: true,
      json: async () => ({
        ok: true,
        phase: 'auto-restart',
        autoRestartRequested: true,
        message: '已直装并请求自动重启',
      }),
    }
  }) as unknown as typeof fetch
  try {
    const result = await mod.directInstallPlugin(
      { owner: 'liustack', name: 'modlens', fullName: 'liustack/modlens', installability: 'verified' },
      (p) => phases.push(p),
    )
    assert.equal(result.ok, true)
    assert.deepEqual(phases, ['init', 'auto-restart', 'done'])
    assert.doesNotMatch(readFileSync(join(root, 'src/client.js'), 'utf8'), /setTimeout\(\s*\(\)\s*=>\s*\{\s*if\s*\(onPhase\)\s*onPhase\("plugin-add"\)/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('directInstallPlugin preserves failure phase and message', async () => {
  const mod = loadClientExports()
  const originalFetch = globalThis.fetch
  const mockFetch: typeof fetch = (async () => ({
    ok: true,
    json: async () => ({
      ok: false,
      phase: 'plugin-add',
      error: '命令失败 (exit 1): allowBuilds',
    }),
  })) as unknown as typeof fetch
  globalThis.fetch = mockFetch
  try {
    await assert.rejects(
      () => mod.directInstallPlugin({ owner: 'o', name: 'n', installability: 'verified' }),
      (err: unknown) => {
        const e = err as Error & { phase?: string }
        assert.match(String(e.message), /allowBuilds/)
        assert.equal(e.phase, 'plugin-add')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})
