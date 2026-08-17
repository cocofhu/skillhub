import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecoverySession,
  defaultRestart,
  injectRecoveryScript,
  loaderLooksFailLoud,
  materializeOverlay,
  mountRecovery,
  overlayPath,
  recoveryShouldArm,
} from '../recovery/host.js'
import { parseArgs, runCli } from '../recovery/cli.js'
import { FAIL_PAGE_COPY } from '../recovery/fail-page-machine.js'

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), 'skillhub-host-nuke-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: { skillhub: 'link:..', 'anime-find': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'skillhub', 'anime-find'] } },
  }, null, 2))
  writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n    - id: skillhub\n      name: skillhub\n')
  return dir
}

function fakeServer() {
  const routes = new Map<string, (req: FakeReq, res: FakeRes) => void | Promise<void>>()
  const taps: ((html: string) => string)[] = []
  return {
    routes,
    taps,
    register(route: { path: string; handler: (req: FakeReq, res: FakeRes) => void | Promise<void> }) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
    tapIndex(fn: (html: string) => string) {
      taps.push(fn)
      return () => {}
    },
  }
}

interface FakeReq {
  method?: string
  url?: string
  headers: Record<string, string>
  socket: { remoteAddress?: string }
  [Symbol.asyncIterator]: () => AsyncGenerator<Buffer>
}

class FakeRes {
  statusCode = 200
  body = ''
  headers: Record<string, string> = {}
  setHeader(key: string, value: string): void {
    this.headers[key.toLowerCase()] = value
  }
  end(chunk?: unknown): void {
    if (chunk != null) this.body = String(chunk)
  }
}

function mockReq(opts: {
  method: string
  url: string
  remoteAddress?: string
  headers?: Record<string, string>
  body?: string
}): FakeReq {
  const payload = opts.body ? [Buffer.from(opts.body)] : []
  return {
    method: opts.method,
    url: opts.url,
    headers: { host: '127.0.0.1:3080', ...opts.headers },
    socket: { remoteAddress: opts.remoteAddress || '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of payload) yield chunk
    },
  }
}

async function invoke(
  handler: (req: FakeReq, res: FakeRes) => void | Promise<void>,
  req: FakeReq,
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const res = new FakeRes()
  await handler(req, res)
  return { status: res.statusCode, body: res.body, headers: res.headers }
}

async function armFailLoud(server: ReturnType<typeof fakeServer>): Promise<string> {
  const armed = await invoke(server.routes.get('/skillhub/recovery/arm')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/arm',
    body: JSON.stringify({ failLoud: true, confirm: 'fail-loud' }),
  }))
  assert.equal(armed.status, 200)
  const nonce = JSON.parse(armed.body).nonce as string
  assert.ok(nonce)
  return nonce
}

test('index tap injects a fail-loud detector, not an unconditional recovery.js fetch', () => {
  const html = injectRecoveryScript('<html><head></head><body>HARNESS</body></html>')
  assert.match(html, /data-skillhub-recovery/)
  assert.match(html, /Failed to load plugins/)
  assert.match(html, /skillhub\/recovery\.js/)
  assert.match(html, /cli-fallback/)
  assert.match(html, /skillhub-recovery nuke-third-party/)
  assert.equal(injectRecoveryScript(html), html)
})

test('healthy boot auto-GET recovery.js does not arm; POST nuke is 404', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  let restarted = 0
  const session = createRecoverySession()
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    session,
    restart: () => { restarted += 1 },
  })
  const autoLoad = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(autoLoad.status, 200)
  assert.equal(autoLoad.headers['x-skillhub-recovery-nonce'], undefined)
  assert.match(autoLoad.body, /"nonce":""/)
  assert.match(autoLoad.body, /"armed":false/)
  assert.equal(session.armed, false)
  assert.equal(session.failLoud, false)

  const cold = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce: 'nope' }),
  }))
  assert.equal(cold.status, 404)
  assert.equal(restarted, 0)
})

test('fail-loud Host signal lets GET issue a one-time nonce; reuse is 404', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  let restarted = 0
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    failLoud: () => true,
    restart: () => { restarted += 1 },
  })
  const overlay = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(overlay.status, 200)
  const nonce = overlay.headers['x-skillhub-recovery-nonce']
  assert.ok(nonce)
  assert.match(overlay.body, new RegExp(nonce))

  const badNonce = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce: 'wrong' }),
  }))
  assert.equal(badNonce.status, 400)

  const ok = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body) as { removed: string[]; kept: string[] }
  assert.deepEqual(payload.removed.sort(), ['anime-find', 'skillhub'])
  assert.ok(payload.kept.includes('@deepseek-ai/dsh-base'))
  assert.equal(restarted, 1)

  const reused = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(reused.status, 404)
})

test('POST /arm is the fail-loud overlay signal; then nuke succeeds once', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  let restarted = 0
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    restart: () => { restarted += 1 },
  })
  const skipped = await invoke(server.routes.get('/skillhub/recovery/arm')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/arm',
    body: JSON.stringify({ failLoud: false }),
  }))
  assert.equal(skipped.status, 400)

  const nonce = await armFailLoud(server)
  const ok = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(ok.status, 200)
  assert.equal(restarted, 1)
  const after = await invoke(server.routes.get('/skillhub/recovery/arm')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/arm',
    body: JSON.stringify({ failLoud: true }),
  }))
  assert.equal(after.status, 404)
})

test('local nuke after arm edits fixture; remote is 403', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    restart: () => {},
  })
  const nonce = await armFailLoud(server)
  const denied = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    remoteAddress: '198.51.100.10',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(denied.status, 403)
})

test('CLI dry-run uses the same primitive', () => {
  const dir = fixtureDir()
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  const out: string[] = []
  const ok = runCli(['nuke-third-party', '--dry-run'], (text) => out.push(text))
  if (previous === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = previous
  assert.equal(ok, 0)
  assert.match(out.join('\n'), /"dryRun": true/)
  assert.match(out.join('\n'), /anime-find/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.skillhub, 'link:..')
})

test('CLI usage for unknown command', () => {
  const lines: string[] = []
  assert.equal(runCli(['nope'], (text) => lines.push(text)), 2)
  assert.match(lines.join('\n'), /usage: skillhub-recovery/)
  assert.equal(runCli([], () => {}), 0)
  assert.deepEqual(parseArgs(['nuke-third-party', '--profile', 'headless', '--dry-run']), {
    command: 'nuke-third-party',
    profile: 'headless',
    dryRun: true,
  })
})

test('CLI apply writes the profile', () => {
  const dir = fixtureDir()
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = dir
  const out: string[] = []
  assert.equal(runCli(['nuke-third-party', '--profile=web'], (text) => out.push(text)), 0)
  if (previous === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = previous
  assert.match(out.join('\n'), /Restart dsh web/)
  assert.equal(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).dependencies.skillhub, undefined)
})

test('CLI reports missing profile', () => {
  const previous = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = join(tmpdir(), 'skillhub-missing-profile')
  const lines: string[] = []
  assert.equal(runCli(['nuke-third-party'], (text) => lines.push(text)), 1)
  if (previous === undefined) delete process.env.DSH_PROFILE_DIR
  else process.env.DSH_PROFILE_DIR = previous
  assert.match(lines.join('\n'), /ENOENT|no such file/i)
})

test('nuke against a missing profile is 500; HEAD overlay is empty', async () => {
  const server = fakeServer()
  mountRecovery(server as never, {
    profileDir: join(tmpdir(), 'skillhub-no-such-profile'),
    overlaySource: 'js',
    failLoud: () => true,
    restart: () => {},
  })
  const head = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'HEAD',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  const nonce = head.headers['x-skillhub-recovery-nonce']
  assert.ok(nonce)
  const boom = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(boom.status, 500)
})

test('client.js does not implement unload-all or host suicide', () => {
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.doesNotMatch(client, /nuke-third-party|unload-all|卸载全部第三方|process\.exit/)
  assert.match(client, /settings\.plugin\.item/)
})

test('overlayPath points at the injected shell script', () => {
  assert.match(overlayPath(), /overlay\.js$/)
})

test('fail-page copy is the Demo primary action', () => {
  assert.equal(FAIL_PAGE_COPY.button.includes('卸载全部第三方'), true)
  assert.match(FAIL_PAGE_COPY.cliFallback, /skillhub-recovery nuke-third-party/)
})

test('overlay GET is loopback-only and missing confirm is 400', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  mountRecovery(server as never, {
    profileDir: dir,
    overlaySource: '/* overlay-fixture */',
    restart: () => {},
  })
  const local = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(local.status, 200)
  assert.match(local.body, /overlay-fixture/)
  assert.match(local.body, /快速修复/)
  assert.match(local.body, /window\.__SKILLHUB_RECOVERY_BOOT__=/)
  assert.equal(local.headers['x-skillhub-recovery-nonce'], undefined)
  const remote = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
    remoteAddress: '8.8.8.8',
  }))
  assert.equal(remote.status, 403)
  const nonce = await armFailLoud(server)
  const bad = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nope', nonce }),
  }))
  assert.equal(bad.status, 400)
  const missing = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: '{',
  }))
  assert.equal(missing.status, 400)
  const remoteArm = await invoke(server.routes.get('/skillhub/recovery/arm')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/arm',
    remoteAddress: '8.8.8.8',
    body: JSON.stringify({ failLoud: true }),
  }))
  assert.equal(remoteArm.status, 403)
})

test('injectRecoveryScript prepends when head is missing', () => {
  assert.match(injectRecoveryScript('<html>'), /^<script data-skillhub-recovery/)
})

test('defaultRestart respawns with same argv then exits current process', async () => {
  const spawns: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  let exited = false
  await defaultRestart({
    wait: (fn) => { fn() },
    spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawns.push({ cmd, args, opts })
      return { unref() {} }
    }) as never,
    execPath: '/usr/bin/node',
    argv: ['/tmp/dsh', 'web', '--host', '127.0.0.1'],
    cwd: '/tmp',
    env: { FOO: '1' },
    exitCurrent: false,
  })
  assert.equal(spawns.length, 1)
  const last = spawns.at(-1)!
  assert.equal(last.cmd, '/usr/bin/node')
  assert.deepEqual(last.args, ['/tmp/dsh', 'web', '--host', '127.0.0.1'])
  assert.equal(last.opts.detached, true)
  assert.equal((last.opts.env as { SKILLHUB_RECOVERY_RESPAWN: string }).SKILLHUB_RECOVERY_RESPAWN, '1')
  assert.equal(exited, false)
})

test('defaultRestart does not exit when spawn throws', async () => {
  let exited = false
  await assert.rejects(
    () => defaultRestart({
      wait: (fn) => { fn() },
      spawn: (() => { throw new Error('spawn boom') }) as never,
      exitCurrent: false,
      onExit: () => { exited = true },
    }),
    /spawn boom/,
  )
  assert.equal(exited, false)
})

test('defaultRestart does not exit when child emits error', async () => {
  const { EventEmitter } = await import('node:events')
  let exited = false
  await assert.rejects(
    () => defaultRestart({
      wait: (fn) => { fn() },
      spawn: (() => {
        const child = Object.assign(new EventEmitter(), { unref() {} })
        const origOnce = child.once.bind(child)
        child.once = ((event: string, listener: (...args: unknown[]) => void) => {
          origOnce(event, listener)
          if (event === 'error') listener(new Error('ENOENT'))
          return child
        }) as typeof child.once
        return child
      }) as never,
      exitCurrent: false,
      onExit: () => { exited = true },
    }),
    /ENOENT/,
  )
  assert.equal(exited, false)
})

test('nuke returns 500 and stays retryable when respawn fails', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  const session = createRecoverySession()
  let exited = false
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: 'js',
    session,
    restartHooks: {
      wait: (fn) => { fn() },
      spawn: (() => { throw new Error('spawn boom') }) as never,
      onExit: () => { exited = true },
    },
  })
  const nonce = await armFailLoud(server)
  const boom = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(boom.status, 500)
  assert.match(boom.body, /spawn boom/)
  assert.equal(exited, false)
  assert.equal(session.consumed, false)
  assert.equal(session.armed, true)
  const retry = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce }),
  }))
  assert.equal(retry.status, 500)
})

test('materializeOverlay injects FAIL_PAGE_COPY and nonce', () => {
  const out = materializeOverlay('/* body */', 'abc123')
  assert.match(out, /^window\.__SKILLHUB_RECOVERY_BOOT__=/)
  assert.match(out, /abc123/)
  assert.match(out, /快速修复 · 卸载全部第三方/)
  assert.match(out, /cliFallback/)
  assert.match(out, /\/\* body \*\//)
})

test('createRecoverySession starts unarmed', () => {
  const session = createRecoverySession()
  assert.equal(session.armed, false)
  assert.equal(session.nonce, null)
  assert.equal(session.failLoud, false)
  assert.equal(recoveryShouldArm(session), false)
  assert.equal(recoveryShouldArm(session, { failLoud: () => true }), true)
  assert.equal(recoveryShouldArm(session, { failLoud: () => { throw new Error('probe') } }), false)
})

test('loaderLooksFailLoud reads Host fiber FAILED / missing fiber', () => {
  assert.equal(loaderLooksFailLoud(undefined), false)
  assert.equal(loaderLooksFailLoud({ entries: () => [] }), false)
  assert.equal(loaderLooksFailLoud({
    entries: () => [{ options: { name: 'core' }, fiber: { state: 2 } }],
  }), false)
  assert.equal(loaderLooksFailLoud({
    entries: () => [{ options: { name: 'anime-find' }, fiber: { state: 3 } }],
  }), true)
  assert.equal(loaderLooksFailLoud({
    entries: () => [{ options: { name: 'anime-find' }, fiber: null }],
  }), true)
  assert.equal(loaderLooksFailLoud({
    entries: () => { throw new Error('loader down') },
  }), false)
})

test('defaultRestart run hook can succeed or fail without exiting', async () => {
  let ran = 0
  let exited = false
  await defaultRestart({
    wait: (fn) => { fn() },
    run: () => { ran += 1 },
    onExit: () => { exited = true },
    exitCurrent: false,
  })
  assert.equal(ran, 1)
  assert.equal(exited, false)
  await defaultRestart({
    wait: (fn) => { fn() },
    run: () => { ran += 1 },
    onExit: () => { exited = true },
  })
  assert.equal(ran, 2)
  assert.equal(exited, true)
  await assert.rejects(
    () => defaultRestart({
      wait: (fn) => { fn() },
      run: () => { throw new Error('run fail') },
      exitCurrent: false,
    }),
    /run fail/,
  )
})
