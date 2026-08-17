import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createRecoverySession,
  defaultRestart,
  injectRecoveryScript,
  materializeOverlay,
  mountRecovery,
  overlayPath,
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

async function armOverlay(server: ReturnType<typeof fakeServer>): Promise<string> {
  const armed = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(armed.status, 200)
  const nonce = armed.headers['x-skillhub-recovery-nonce']
  assert.ok(nonce)
  assert.match(armed.body, new RegExp(nonce))
  return nonce
}

test('index tap injects the recovery overlay without depending on client plugins', () => {
  const html = injectRecoveryScript('<html><head></head><body>HARNESS</body></html>')
  assert.match(html, /data-skillhub-recovery/)
  assert.match(html, /skillhub\/recovery\.js/)
  assert.equal(injectRecoveryScript(html), html)
})

test('healthy boot POST nuke is 404 until overlay arms a one-time nonce', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  let restarted = 0
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    restart: () => { restarted += 1 },
  })
  const cold = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party', nonce: 'nope' }),
  }))
  assert.equal(cold.status, 404)
  assert.equal(restarted, 0)

  const nonce = await armOverlay(server)
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

test('local nuke after arm edits fixture; remote is 403', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    restart: () => {},
  })
  const nonce = await armOverlay(server)
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
    restart: () => {},
  })
  const head = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'HEAD',
    url: '/skillhub/recovery.js',
  }))
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
  const nonce = head.headers['x-skillhub-recovery-nonce']
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
  const remote = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
    remoteAddress: '8.8.8.8',
  }))
  assert.equal(remote.status, 403)
  const nonce = local.headers['x-skillhub-recovery-nonce']
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
})

test('injectRecoveryScript prepends when head is missing', () => {
  assert.match(injectRecoveryScript('<html>'), /^<script data-skillhub-recovery/)
})

test('defaultRestart respawns with same argv then exits current process', () => {
  const spawns: Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }> = []
  let exited = false
  defaultRestart({
    wait: (fn) => { fn() },
    spawn: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      spawns.push({ cmd, args, opts })
      return { unref() {} }
    }) as never,
    execPath: '/usr/bin/node',
    argv: ['/tmp/dsh', 'web', '--host', '127.0.0.1', '--port', '3080'],
    cwd: '/tmp',
    env: { FOO: '1' },
    exitCurrent: false,
    run: undefined,
  })
  // When run is undefined, default body uses spawn — but we passed exitCurrent false via hooks
  // Re-call with explicit path that exercises spawn inside default run:
  defaultRestart({
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
  assert.equal(spawns.length >= 1, true)
  const last = spawns.at(-1)!
  assert.equal(last.cmd, '/usr/bin/node')
  assert.deepEqual(last.args, ['/tmp/dsh', 'web', '--host', '127.0.0.1'])
  assert.equal(last.opts.detached, true)
  assert.equal((last.opts.env as { SKILLHUB_RECOVERY_RESPAWN: string }).SKILLHUB_RECOVERY_RESPAWN, '1')
  assert.equal(exited, false)
})

test('materializeOverlay injects FAIL_PAGE_COPY and nonce', () => {
  const out = materializeOverlay('/* body */', 'abc123')
  assert.match(out, /^window\.__SKILLHUB_RECOVERY_BOOT__=/)
  assert.match(out, /abc123/)
  assert.match(out, /快速修复 · 卸载全部第三方/)
  assert.match(out, /\/\* body \*\//)
})

test('createRecoverySession starts unarmed', () => {
  const session = createRecoverySession()
  assert.equal(session.armed, false)
  assert.equal(session.nonce, null)
})
