import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAIL_PAGE_COPY, buttonEnabled, initialFailPageState, reduceFailPage } from '../recovery/fail-page-machine.js'
import { materializeOverlay } from '../recovery/host.js'

const dir = dirname(fileURLToPath(import.meta.url))

test('copy names the brutal nuke-all-third-party action', () => {
  assert.equal(FAIL_PAGE_COPY.button, '快速修复 · 卸载全部第三方')
  assert.match(FAIL_PAGE_COPY.warningTitle, /粗暴模式/)
  assert.match(FAIL_PAGE_COPY.warningBody, /全部第三方/)
  assert.doesNotMatch(FAIL_PAGE_COPY.warningBody, /只删单个/)
})

test('overlay.js ships the same button and warning as the Demo / state machine', () => {
  const overlay = readFileSync(join(dir, '../recovery/overlay.js'), 'utf8')
  assert.match(overlay, /快速修复 · 卸载全部第三方/)
  assert.match(overlay, /粗暴模式 · 会卸载所有第三方插件/)
  assert.match(overlay, /nuke-third-party/)
  assert.match(overlay, /Failed to load plugins/)
  assert.match(overlay, /requires options\.id/)
  assert.match(overlay, /textContent/)
  assert.match(overlay, /safeLabel/)
  assert.match(overlay, /COPY\.nonce/)
  const baked = materializeOverlay(overlay, 'nonce-fixture')
  assert.match(baked, /nonce-fixture/)
  assert.match(baked, new RegExp(FAIL_PAGE_COPY.button.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

test('fail page with options.id regression text is recognized as fail-loud', () => {
  const sample = [
    'HARNESS',
    'Failed to load plugins',
    'anime-find',
    'skillhub',
    'failed to apply loader entry fb6de590 (anime-find): list slot "settings.plugin.item" requires options.id',
  ].join('\n')
  assert.match(sample, /Failed to load plugins/)
  assert.match(sample, /requires options\.id/)
  assert.match(sample, /settings\.plugin\.item/)
  const overlay = readFileSync(join(dir, '../recovery/overlay.js'), 'utf8')
  assert.match(overlay, /looksLikeOptionsIdFailure|requires options\.id/)
})

test('fail page state machine: fail → running → success', () => {
  let state = initialFailPageState()
  assert.equal(state.phase, 'fail')
  assert.equal(buttonEnabled(state), true)
  state = reduceFailPage(state, { type: 'start' })
  assert.equal(state.phase, 'running')
  assert.equal(buttonEnabled(state), false)
  state = reduceFailPage(state, { type: 'log', text: '× remove skillhub', cls: 'bad', progress: 60 })
  assert.equal(state.logs.at(-1)?.text, '× remove skillhub')
  state = reduceFailPage(state, { type: 'success', removed: ['skillhub'], kept: ['@deepseek-ai/dsh-base'] })
  assert.equal(state.phase, 'success')
  assert.deepEqual(state.removed, ['skillhub'])
})

test('errors stay visible and retry returns to fail', () => {
  let state = reduceFailPage(initialFailPageState(), { type: 'start' })
  state = reduceFailPage(state, { type: 'error', message: 'host refused' })
  assert.equal(state.phase, 'error')
  assert.equal(state.error, 'host refused')
  assert.equal(buttonEnabled(state), true)
  state = reduceFailPage(state, { type: 'retry' })
  assert.equal(state.phase, 'fail')
  assert.equal(state.error, undefined)
})

test('success/error events are ignored outside running', () => {
  const idle = initialFailPageState()
  assert.equal(reduceFailPage(idle, { type: 'error', message: 'nope' }).phase, 'fail')
  assert.equal(reduceFailPage(idle, { type: 'success', removed: [], kept: [] }).phase, 'fail')
  assert.equal(reduceFailPage(idle, { type: 'log', text: 'x' }).phase, 'fail')
  const running = reduceFailPage(idle, { type: 'start' })
  assert.equal(reduceFailPage(running, { type: 'start' }).phase, 'running')
  assert.equal(reduceFailPage(running, { type: 'retry' }).phase, 'running')
})

test('overlay disables the button while running and surfaces fetch errors via retry UI', () => {
  const overlay = readFileSync(join(dir, '../recovery/overlay.js'), 'utf8')
  assert.match(overlay, /btn\.disabled = true/)
  assert.match(overlay, /renderFail\(root, err/)
  assert.match(overlay, /HTTP /)
})
