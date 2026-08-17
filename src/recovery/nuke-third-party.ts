import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { classifyPluginNames, isThirdPartyPlugin, normalizePluginName } from './baseline.js'
import { listPatchPluginNames, stripThirdPartyFromPatch } from './patch-yaml.js'

export const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'

export interface ProfileManifest {
  name?: string
  private?: boolean
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] }; bundle?: { patch?: string } }
  [key: string]: unknown
}

export interface ProfileState {
  profile: string
  dir: string
  dependencies: Record<string, string>
  bundles: string[]
  patchYaml: string
  manifest: ProfileManifest
}

export interface NukeResult {
  profile: string
  dir: string
  removed: string[]
  kept: string[]
  logs: string[]
  next: ProfileState
}

function unique(names: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of names) {
    const n = normalizePluginName(name)
    if (!n || seen.has(n)) continue
    seen.add(n)
    out.push(n)
  }
  return out
}

export function readProfileState(dir: string, profile = 'web'): ProfileState {
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as ProfileManifest
  const patchPath = join(dir, PROFILE_PATCH_FILENAME)
  const patchYaml = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : '[]\n'
  return {
    profile,
    dir,
    dependencies: { ...(manifest.dependencies ?? {}) },
    bundles: [...(manifest.dsh?.profile?.bundles ?? [])],
    patchYaml,
    manifest,
  }
}

export function writeProfileState(state: ProfileState): void {
  const manifest: ProfileManifest = {
    ...state.manifest,
    dependencies: state.dependencies,
    dsh: {
      ...state.manifest.dsh,
      profile: {
        ...state.manifest.dsh?.profile,
        bundles: state.bundles,
      },
    },
  }
  writeFileSync(join(state.dir, 'package.json'), `${JSON.stringify(manifest, undefined, 2)}\n`)
  writeFileSync(join(state.dir, PROFILE_PATCH_FILENAME), state.patchYaml.endsWith('\n') ? state.patchYaml : `${state.patchYaml}\n`)
}

export function planNukeThirdParty(state: ProfileState): NukeResult {
  const patchNames = listPatchPluginNames(state.patchYaml)
  const all = unique([...Object.keys(state.dependencies), ...state.bundles, ...patchNames])
  const { thirdParty, baseline } = classifyPluginNames(all)
  const removedSet = new Set(thirdParty)
  const nextDeps = Object.fromEntries(
    Object.entries(state.dependencies).filter(([name]) => !isThirdPartyPlugin(name)),
  )
  const nextBundles = state.bundles.filter((name) => !isThirdPartyPlugin(name))
  const nextPatch = stripThirdPartyFromPatch(state.patchYaml)
  const kept = unique([
    ...baseline,
    ...nextBundles,
    ...Object.keys(nextDeps).filter((name) => !isThirdPartyPlugin(name)),
    ...listPatchPluginNames(nextPatch),
  ]).filter((name) => !removedSet.has(name))
  const next: ProfileState = {
    ...state,
    dependencies: nextDeps,
    bundles: nextBundles,
    patchYaml: nextPatch,
    manifest: {
      ...state.manifest,
      dependencies: nextDeps,
      dsh: {
        ...state.manifest.dsh,
        profile: { ...state.manifest.dsh?.profile, bundles: nextBundles },
      },
    },
  }
  const logs = [
    '$ dsh recovery nuke-third-party --profile ' + state.profile,
    '! unloading ALL third-party plugins (no cherry-pick)',
    ...thirdParty.map((name) => `× remove ${name}`),
    `✓ baseline kept · third-party count = ${classifyPluginNames([...Object.keys(nextDeps), ...nextBundles, ...listPatchPluginNames(nextPatch)]).thirdParty.length}`,
  ]
  return {
    profile: state.profile,
    dir: state.dir,
    removed: [...removedSet].sort(),
    kept: kept.sort(),
    logs,
    next,
  }
}

export function applyNukeThirdParty(dir: string, profile = 'web'): NukeResult {
  const planned = planNukeThirdParty(readProfileState(dir, profile))
  writeProfileState(planned.next)
  return planned
}
