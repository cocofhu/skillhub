import assert from 'node:assert/strict'
import test from 'node:test'
import { classifyPluginNames, isBaselinePlugin, isThirdPartyPlugin } from '../recovery/baseline.js'

test('anime-find and skillhub are third-party', () => {
  assert.equal(isThirdPartyPlugin('anime-find'), true)
  assert.equal(isThirdPartyPlugin('skillhub'), true)
  assert.equal(isBaselinePlugin('anime-find'), false)
  assert.equal(isBaselinePlugin('skillhub'), false)
})

test('core/ui/settings and template bundles are baseline', () => {
  for (const name of ['core', 'ui', 'settings', '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    assert.equal(isBaselinePlugin(name), true, name)
    assert.equal(isThirdPartyPlugin(name), false, name)
  }
})

test('classify selects every third-party and never a baseline', () => {
  const { thirdParty, baseline } = classifyPluginNames([
    '@deepseek-ai/dsh-base',
    '@deepseek-ai/dsh-web-app',
    'core',
    'ui',
    'settings',
    'anime-find',
    'skillhub',
    'anime-find',
  ])
  assert.deepEqual(thirdParty, ['anime-find', 'skillhub'])
  assert.deepEqual(baseline, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'core', 'ui', 'settings'])
})

test('empty list and baseline-only stay empty of third-party', () => {
  assert.deepEqual(classifyPluginNames([]), { thirdParty: [], baseline: [] })
  assert.deepEqual(classifyPluginNames(['core', '@deepseek-ai/dsh-base']), {
    thirdParty: [],
    baseline: ['core', '@deepseek-ai/dsh-base'],
  })
})
