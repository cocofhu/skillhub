import assert from 'node:assert/strict'
import test from 'node:test'
import { listPatchPluginNames, stripThirdPartyFromPatch } from '../recovery/patch-yaml.js'

test('lists insert names from a skillhub-style patch', () => {
  const yaml = [
    '- insert:',
    '    - id: skillhub',
    '      name: skillhub',
    '    - id: anime-find',
    '      name: anime-find',
    '',
  ].join('\n')
  assert.deepEqual(listPatchPluginNames(yaml).sort(), ['anime-find', 'skillhub'])
})

test('strips third-party inserts and keeps baseline entries', () => {
  const yaml = [
    '# user layer',
    '- insert:',
    '    - id: skillhub',
    '      name: skillhub',
    '    - id: settings',
    '      name: settings',
    '- id: webserver',
    '  name: webserver',
    '- id: anime-find',
    '  name: anime-find',
    '',
  ].join('\n')
  const next = stripThirdPartyFromPatch(yaml)
  const names = listPatchPluginNames(next)
  assert.equal(names.includes('skillhub'), false)
  assert.equal(names.includes('anime-find'), false)
  assert.ok(names.includes('settings'))
  assert.ok(names.includes('webserver'))
})

test('third-party-only patch collapses to an empty list', () => {
  const next = stripThirdPartyFromPatch('- insert:\n    - id: skillhub\n      name: skillhub\n')
  assert.equal(listPatchPluginNames(next).length, 0)
  assert.match(next.trim(), /^\[\]$/)
})

test('empty documented patch stays an empty list', () => {
  assert.equal(listPatchPluginNames('[]\n').length, 0)
  assert.match(stripThirdPartyFromPatch('# note\n[]\n').trim(), /\[\]$/)
})

