import assert from 'node:assert/strict'
import test from 'node:test'
import { publicConfig, sanitizePatch, withDefaults } from '../config-store.js'

test('withDefaults fills required fields', () => {
  const cfg = withDefaults({ skillsDir: '/tmp/skills', timeoutMs: 5000, userAgent: 'test' })
  assert.equal(cfg.apiBase, 'https://api.skillhub.cn')
  assert.equal(cfg.webBase, 'https://skillhub.cn')
  assert.equal(cfg.skillsDir, '/tmp/skills')
  assert.equal(cfg.sortBy, 'score')
  assert.equal('cosBase' in cfg, false)
})

test('sanitizePatch ignores leftover cosBase and invalid urls', () => {
  const patch = sanitizePatch({
    apiBase: 'https://api.example.com/',
    cosBase: 'https://cos.example',
    webBase: 'not-a-url',
    skillsDir: ' ~/.dsh/skills ',
    timeoutMs: 100,
    maxResults: 99,
    sortBy: 'downloads',
  })
  assert.equal(patch.apiBase, 'https://api.example.com')
  assert.equal(patch.webBase, undefined)
  assert.equal(patch.skillsDir, '~/.dsh/skills')
  assert.equal(patch.timeoutMs, undefined)
  assert.equal(patch.maxResults, 80)
  assert.equal(patch.sortBy, 'downloads')
  assert.equal('cosBase' in patch, false)
})

test('publicConfig omits userAgent', () => {
  const pub = publicConfig(withDefaults({ skillsDir: '/tmp/skills', userAgent: 'secret-ua' }))
  assert.equal('userAgent' in pub, false)
  assert.equal(pub.apiBase, 'https://api.skillhub.cn')
})
