import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FAIL_PAGE_COPY, buttonEnabled, initialFailPageState, reduceFailPage } from '../recovery/fail-page-machine.js'

const dir = dirname(fileURLToPath(import.meta.url))

test('copy names the brutal nuke-all-third-party action', () => {
  assert.equal(FAIL_PAGE_COPY.button, '快速修复 · 卸载全部第三方')
  assert.match(FAIL_PAGE_COPY.warningTitle, /粗暴模式/)
  assert.match(FAIL_PAGE_COPY.warningBody, /全部第三方/)
  assert.doesNotMatch(FAIL_PAGE_COPY.warningBody, /只删单个/)
})

test('overlay.js ships the same button and warning as the Demo', () => {
  const overlay = readFileSync(join(dir, '../recovery/overlay.js'), 'utf8')
  assert.match(overlay, /快速修复 · 卸载全部第三方/)
  assert.match(overlay, /粗暴模式 · 会卸载所有第三方插件/)
  assert.match(overlay, /nuke-third-party/)
  assert.match(overlay, /Failed to load plugins/)
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

