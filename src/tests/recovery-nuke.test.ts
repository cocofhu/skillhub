import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPluginNames } from '../recovery/baseline.js'
import { applyNukeThirdParty, planNukeThirdParty, readProfileState } from '../recovery/nuke-third-party.js'
import { listPatchPluginNames } from '../recovery/patch-yaml.js'

function fixtureProfile(extra?: { deps?: Record<string, string>; bundles?: string[]; patch?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'skillhub-nuke-'))
  const bundles = extra?.bundles ?? ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'anime-find', 'skillhub']
  const dependencies = extra?.deps ?? {
    'anime-find': 'github:example/anime-find',
    skillhub: 'github:cocofhu/skillhub#v0.2.1',
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies,
    dsh: { profile: { bundles } },
  }, null, 2) + '\n')
  writeFileSync(join(dir, 'cordis.patch.yml'), extra?.patch ?? [
    '- insert:',
    '    - id: skillhub',
    '      name: skillhub',
    '    - id: anime-find',
    '      name: anime-find',
    '',
  ].join('\n'))
  return dir
}

test('nuke removes third-party deps/layers and keeps baseline', () => {
  const dir = fixtureProfile()
  const result = applyNukeThirdParty(dir, 'web')
  assert.deepEqual(result.removed, ['anime-find', 'skillhub'])
  assert.ok(result.kept.includes('@deepseek-ai/dsh-base'))
  assert.ok(result.kept.includes('@deepseek-ai/dsh-web-app'))
  assert.equal(result.removed.includes('@deepseek-ai/dsh-base'), false)
  const next = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>
    dsh: { profile: { bundles: string[] } }
  }
  assert.deepEqual(Object.keys(next.dependencies), [])
  assert.deepEqual(next.dsh.profile.bundles, ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'])
  const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
  assert.equal(listPatchPluginNames(patch).includes('skillhub'), false)
  assert.equal(listPatchPluginNames(patch).includes('anime-find'), false)
  const leftover = classifyPluginNames([
    ...Object.keys(next.dependencies),
    ...next.dsh.profile.bundles,
    ...listPatchPluginNames(patch),
  ])
  assert.equal(leftover.thirdParty.length, 0)
  assert.match(result.logs.join('\n'), /unloading ALL third-party/)
  assert.match(result.logs.join('\n'), /remove skillhub/)
})

test('baseline-only and empty profiles are a no-op, never unload-all', () => {
  const only = fixtureProfile({
    deps: {},
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'],
    patch: '[]\n',
  })
  const planned = planNukeThirdParty(readProfileState(only, 'web'))
  assert.deepEqual(planned.removed, [])
  assert.ok(planned.kept.includes('@deepseek-ai/dsh-base'))
  const emptyDir = mkdtempSync(join(tmpdir(), 'skillhub-empty-'))
  writeFileSync(join(emptyDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  }, null, 2))
  writeFileSync(join(emptyDir, 'cordis.patch.yml'), '[]\n')
  const empty = planNukeThirdParty(readProfileState(emptyDir, 'web'))
  assert.deepEqual(empty.removed, [])
  assert.deepEqual(empty.kept, [])
})

test('L1 fixture smoke: after nuke third-party count is 0 and baseline entries stay ACTIVE', () => {
  const dir = fixtureProfile()
  mkdirSync(join(dir, 'node_modules'), { recursive: true })
  const result = applyNukeThirdParty(dir, 'web')
  assert.equal(result.removed.length > 0, true)
  const state = readProfileState(dir, 'web')
  const names = [...Object.keys(state.dependencies), ...state.bundles, ...listPatchPluginNames(state.patchYaml)]
  const classified = classifyPluginNames(names)
  assert.equal(classified.thirdParty.length, 0, 'third-party count must be 0')
  assert.ok(classified.baseline.includes('@deepseek-ai/dsh-base'))
  const boot = classified.baseline.map((name) => ({ name, phase: 'ACTIVE' }))
  assert.equal(boot.every((row) => row.phase === 'ACTIVE'), true)
  assert.equal(boot.some((row) => row.name === 'anime-find' || row.name === 'skillhub'), false)
})
