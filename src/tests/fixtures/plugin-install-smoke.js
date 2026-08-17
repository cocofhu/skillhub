#!/usr/bin/env node
/**
 * L1 Host smoke: fixture install-plan + fake dsh CLI argv capture + SIGTERM hook.
 * Does not start a full web UI / browser.
 *
 * Usage: node lib/tests/fixtures/plugin-install-smoke.js
 * Exit 0 on success.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { withDefaults } from '../../config-store.js'
import { installMarketPlugin } from '../../plugin-install.js'

const root = mkdtempSync(join(tmpdir(), 'skillhub-plugin-install-smoke-'))
const binDir = join(root, 'bin')
const profileDir = join(root, 'profiles', 'web')
const argvLog = join(root, 'argv.log')
const assertFile = join(root, 'assert.json')
mkdirSync(binDir, { recursive: true })
mkdirSync(profileDir, { recursive: true })
writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'web-profile', private: true }, null, 2))

const fakeDsh = join(binDir, 'dsh')
writeFileSync(
  fakeDsh,
  `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.SKILLHUB_SMOKE_ARGV_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.SKILLHUB_SMOKE_FAIL === '1') {
  console.error('allowBuilds required')
  process.exit(2)
}
console.log('fake dsh ok')
`,
)
chmodSync(fakeDsh, 0o755)

const pinned = 'github:demo/owner-plugin#abcdef0123456789abcdef0123456789abcdef01'
const plan = {
  command: `dsh plugin --profile web add ${pinned}`,
  source: pinned,
  profile: 'web',
}
const catalog = {
  items: [{ owner: 'demo', name: 'owner-plugin', fullName: 'demo/owner-plugin', installability: 'verified' }],
}

function fetchFixture(url) {
  if (String(url).includes('/install-plan')) return plan
  return catalog
}

async function runCase(label, fail) {
  let restarts = 0
  const result = await installMarketPlugin(
    withDefaults({ timeoutMs: 5000 }),
    { owner: 'demo', name: 'owner-plugin', installability: 'verified' },
    {
      fetchJson: async (url) => fetchFixture(url),
      runCommand: async (cmd, args, opts) => {
        // Simulate npx forwarding to fake dsh by recording the intended argv.
        writeFileSync(argvLog, JSON.stringify({ cmd, args, cwd: opts.cwd }) + '\n')
        if (fail) throw new Error('命令失败 (exit 2): allowBuilds required')
        return 'fake dsh ok'
      },
      profileDir: () => profileDir,
      requestRestart: () => { restarts += 1 },
      scheduleRestart: (fn) => fn(),
    },
  )
  return { label, result, restarts }
}

const okCase = await runCase('success', false)
assert.equal(okCase.result.ok, true, 'success path should ok')
assert.equal(okCase.result.autoRestartRequested, true)
assert.equal(okCase.restarts, 1, 'success path SIGTERM once')
assert.equal(okCase.result.source, pinned)
const recorded = JSON.parse(readFileSync(argvLog, 'utf8'))
assert.equal(recorded.cmd, 'npx')
assert.deepEqual(recorded.args.slice(-4), ['--profile', 'web', 'add', pinned])
assert.equal(recorded.cwd, profileDir)

const failCase = await runCase('failure', true)
assert.equal(failCase.result.ok, false)
assert.equal(failCase.result.phase, 'plugin-add')
assert.equal(failCase.restarts, 0, 'failure must not SIGTERM')
assert.match(failCase.result.error || '', /allowBuilds/)

let planFetched = false
const gate = await installMarketPlugin(
  withDefaults({}),
  { owner: 'demo', name: 'owner-plugin', installability: 'verified' },
  {
    fetchJson: async (url) => {
      if (String(url).includes('/install-plan')) {
        planFetched = true
        throw new Error('should not fetch plan')
      }
      return {
        items: [{ owner: 'demo', name: 'owner-plugin', installability: 'unsupported' }],
      }
    },
    runCommand: async () => { throw new Error('should not spawn') },
    profileDir: () => profileDir,
    requestRestart: () => { throw new Error('should not restart') },
    scheduleRestart: (fn) => fn(),
  },
)
assert.equal(gate.ok, false)
assert.equal(planFetched, false, 'upstream unsupported must not fetch install-plan')
assert.match(gate.error || '', /verified/)

const summary = {
  ok: true,
  root,
  pinned,
  successRestarts: okCase.restarts,
  failureRestarts: failCase.restarts,
  argv: recorded.args,
  upstreamGate: true,
}
writeFileSync(assertFile, JSON.stringify(summary, null, 2))
console.log('plugin-install L1 smoke passed')
console.log(JSON.stringify(summary, null, 2))
console.log('assert file:', pathToFileURL(assertFile).href)
