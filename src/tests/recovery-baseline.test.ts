import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyPluginNames,
  isBaselineDependency,
  isBaselinePlugin,
  isBaselinePluginId,
  isThirdPartyPlugin,
} from '../recovery/baseline.js'

test('anime-find and skillhub are third-party', () => {
  assert.equal(isThirdPartyPlugin('anime-find'), true)
  assert.equal(isThirdPartyPlugin('skillhub'), true)
  assert.equal(isBaselinePlugin('anime-find'), false)
  assert.equal(isBaselinePlugin('skillhub'), false)
})

test('core/ui/settings fiber ids are baseline; template bundles are baseline deps', () => {
  for (const name of ['core', 'ui', 'settings']) {
    assert.equal(isBaselinePluginId(name), true, name)
    assert.equal(isBaselineDependency(name), false, `${name} must NOT be a dependency whitelist hit`)
  }
  for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']) {
    assert.equal(isBaselineDependency(name), true, name)
    assert.equal(isBaselinePlugin(name), true, name)
  }
})

test('npm package named settings is third-party dependency (not protected by fiber id)', () => {
  assert.equal(isThirdPartyPlugin('settings', 'dependency'), true)
  assert.equal(isBaselineDependency('settings'), false)
  assert.equal(isThirdPartyPlugin('settings', 'plugin-id'), false)
})

test('arbitrary @deepseek-ai scoped packages are NOT auto-baseline', () => {
  assert.equal(isBaselineDependency('@deepseek-ai/random-plugin'), false)
  assert.equal(isThirdPartyPlugin('@deepseek-ai/random-plugin', 'dependency'), true)
  assert.equal(isThirdPartyPlugin('@deepseek-ai/random-plugin', 'bundle'), true)
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
