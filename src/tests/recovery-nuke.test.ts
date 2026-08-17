import assert from 'node:assert/strict'
import test from 'node:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { classifyPluginNames } from '../recovery/baseline.js'
import {
  applyNukeThirdParty,
  planNukeThirdParty,
  readProfileState,
  reconcileRemovedPackages,
} from '../recovery/nuke-third-party.js'
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
  const result = applyNukeThirdParty(dir, 'web', {
    reconcile: true,
    exec: () => {
      // fixture has no real pnpm workspace; simulate success
    },
  })
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
  assert.match(result.logs.join('\n'), /pnpm remove/)
})

test('dependency named settings is removed; fiber id settings stays baseline in patch', () => {
  const dir = fixtureProfile({
    deps: { settings: '1.2.3', skillhub: 'link:..' },
    bundles: ['@deepseek-ai/dsh-base', 'settings'],
    patch: '- id: core\n  name: core\n',
  })
  const planned = planNukeThirdParty(readProfileState(dir, 'web'))
  assert.ok(planned.removed.includes('settings'))
  assert.ok(planned.removed.includes('skillhub'))
  assert.equal(planned.removed.includes('core'), false)
  assert.ok(planned.kept.includes('@deepseek-ai/dsh-base'))
  assert.ok(planned.kept.includes('core'))
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

test('L1 fixture smoke: after nuke third-party count is 0 and node_modules layers are gone', () => {
  const dir = fixtureProfile()
  const animeMod = join(dir, 'node_modules', 'anime-find')
  const skillMod = join(dir, 'node_modules', 'skillhub')
  mkdirSync(animeMod, { recursive: true })
  mkdirSync(skillMod, { recursive: true })
  writeFileSync(join(animeMod, 'package.json'), '{"name":"anime-find"}\n')
  writeFileSync(join(skillMod, 'package.json'), '{"name":"skillhub"}\n')
  const result = applyNukeThirdParty(dir, 'web', {
    exec: (_cmd, _args, cwd) => {
      // simulate pnpm remove by deleting modules ourselves when exec is stubbed as no-op
      void cwd
    },
  })
  // Force the fallback path to prove layers are cleaned when pnpm is unavailable.
  reconcileRemovedPackages(dir, result.removed, {
    exec: () => {
      throw new Error('pnpm unavailable in fixture')
    },
  })
  assert.equal(result.removed.length > 0, true)
  const state = readProfileState(dir, 'web')
  const names = [...Object.keys(state.dependencies), ...state.bundles, ...listPatchPluginNames(state.patchYaml)]
  const classified = classifyPluginNames(names)
  assert.equal(classified.thirdParty.length, 0, 'third-party count must be 0')
  assert.ok(classified.baseline.includes('@deepseek-ai/dsh-base'))
  assert.equal(existsSync(animeMod), false, 'anime-find node_modules layer must be removed')
  assert.equal(existsSync(skillMod), false, 'skillhub node_modules layer must be removed')
})

test('home cordis.patch.yml third-party inserts are stripped', () => {
  const dir = fixtureProfile()
  const home = mkdtempSync(join(tmpdir(), 'skillhub-home-'))
  const homePatch = join(home, 'cordis.patch.yml')
  writeFileSync(homePatch, '- insert:\n    - id: anime-find\n      name: anime-find\n')
  applyNukeThirdParty(dir, 'web', {
    homePatchPath: homePatch,
    exec: () => {},
  })
  const text = readFileSync(homePatch, 'utf8')
  assert.equal(listPatchPluginNames(text).includes('anime-find'), false)
})
