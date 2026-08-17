import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultRestart, injectRecoveryScript, mountRecovery, overlayPath } from '../recovery/host.js'
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
  setHeader(_key: string, _value: string): void {}
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
): Promise<{ status: number; body: string }> {
  const res = new FakeRes()
  await handler(req, res)
  return { status: res.statusCode, body: res.body }
}

test('index tap injects the recovery overlay without depending on client plugins', () => {
  const html = injectRecoveryScript('<html><head></head><body>HARNESS</body></html>')
  assert.match(html, /data-skillhub-recovery/)
  assert.match(html, /skillhub\/recovery\.js/)
  assert.equal(injectRecoveryScript(html), html)
})

test('local nuke request edits the fixture profile; remote is 403', async () => {
  const dir = fixtureDir()
  const server = fakeServer()
  let restarted = 0
  mountRecovery(server as never, {
    profile: 'web',
    profileDir: dir,
    overlaySource: '/* overlay */',
    restart: () => { restarted += 1 },
  })
  assert.equal(server.taps.length, 1)
  assert.ok(server.routes.has('/skillhub/recovery/nuke'))
  const ok = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party' }),
  }))
  assert.equal(ok.status, 200)
  const payload = JSON.parse(ok.body) as { removed: string[]; kept: string[] }
  assert.deepEqual(payload.removed.sort(), ['anime-find', 'skillhub'])
  assert.ok(payload.kept.includes('@deepseek-ai/dsh-base'))
  assert.equal(restarted, 1)
  const denied = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    remoteAddress: '198.51.100.10',
    body: JSON.stringify({ confirm: 'nuke-third-party' }),
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
  const boom = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nuke-third-party' }),
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
  const remote = await invoke(server.routes.get('/skillhub/recovery.js')!, mockReq({
    method: 'GET',
    url: '/skillhub/recovery.js',
    remoteAddress: '8.8.8.8',
  }))
  assert.equal(remote.status, 403)
  const bad = await invoke(server.routes.get('/skillhub/recovery/nuke')!, mockReq({
    method: 'POST',
    url: '/skillhub/recovery/nuke',
    body: JSON.stringify({ confirm: 'nope' }),
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

test('defaultRestart schedules process.exit(0)', () => {
  let called = false
  defaultRestart({
    run: () => { called = true },
    wait: (fn) => { fn() },
  })
  assert.equal(called, true)
})
