import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  classifyPluginNames,
  isThirdPartyPlugin,
  normalizePluginName,
} from './baseline.js'
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

export interface ApplyNukeOptions {
  /** Run pnpm remove + lockfile reconcile (default true). */
  reconcile?: boolean
  /** Optional home-level cordis.patch.yml that takes precedence over profile patch. */
  homePatchPath?: string
  exec?: (command: string, args: string[], cwd: string) => void
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
  const depNames = Object.keys(state.dependencies)
  const thirdFromDeps = classifyPluginNames(depNames, 'dependency').thirdParty
  const thirdFromBundles = classifyPluginNames(state.bundles, 'bundle').thirdParty
  const thirdFromPatch = classifyPluginNames(patchNames, 'plugin-id').thirdParty
  const thirdParty = unique([...thirdFromDeps, ...thirdFromBundles, ...thirdFromPatch])
  const removedSet = new Set(thirdParty)

  const nextDeps = Object.fromEntries(
    Object.entries(state.dependencies).filter(([name]) => !isThirdPartyPlugin(name, 'dependency')),
  )
  const nextBundles = state.bundles.filter((name) => !isThirdPartyPlugin(name, 'bundle'))
  const nextPatch = stripThirdPartyFromPatch(state.patchYaml, (name) => isThirdPartyPlugin(name, 'plugin-id'))

  const kept = unique([
    ...classifyPluginNames(Object.keys(nextDeps), 'dependency').baseline,
    ...classifyPluginNames(nextBundles, 'bundle').baseline,
    ...classifyPluginNames(listPatchPluginNames(nextPatch), 'plugin-id').baseline,
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
  const leftover = classifyPluginNames(
    [...Object.keys(nextDeps), ...nextBundles, ...listPatchPluginNames(nextPatch)],
    'auto',
  )
  const logs = [
    '$ dsh recovery nuke-third-party --profile ' + state.profile,
    '! unloading ALL third-party plugins (no cherry-pick)',
    ...thirdParty.map((name) => `× remove ${name}`),
    `✓ baseline kept · third-party count = ${leftover.thirdParty.length}`,
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

function defaultExec(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, { cwd, stdio: 'pipe' })
}

/** Align with `dsh plugin remove`: pnpm remove + drop node_modules entries when needed. */
export function reconcileRemovedPackages(
  dir: string,
  removed: readonly string[],
  options: Pick<ApplyNukeOptions, 'exec'> = {},
): string[] {
  const notes: string[] = []
  if (!removed.length) return notes
  const run = options.exec ?? defaultExec
  try {
    run('pnpm', ['remove', ...removed, '--dir', dir], dir)
    notes.push(`$ pnpm remove ${removed.join(' ')} --dir ${dir}`)
  } catch (err) {
    notes.push(`! pnpm remove failed (${err instanceof Error ? err.message : String(err)}); falling back to manual node_modules cleanup`)
    for (const name of removed) {
      const target = join(dir, 'node_modules', ...name.split('/'))
      if (existsSync(target)) {
        rmSync(target, { recursive: true, force: true })
        notes.push(`× rm node_modules/${name}`)
      }
    }
  }
  return notes
}

export function stripHomePatchThirdParty(homePatchPath: string | undefined, removed: readonly string[]): string[] {
  const notes: string[] = []
  if (!homePatchPath || !existsSync(homePatchPath)) return notes
  const before = readFileSync(homePatchPath, 'utf8')
  const after = stripThirdPartyFromPatch(before, (name) => {
    if (removed.includes(normalizePluginName(name))) return true
    return isThirdPartyPlugin(name, 'plugin-id')
  })
  if (after !== before) {
    writeFileSync(homePatchPath, after.endsWith('\n') ? after : `${after}\n`)
    notes.push(`$ strip third-party from ${homePatchPath}`)
  }
  return notes
}

export function applyNukeThirdParty(dir: string, profile = 'web', options: ApplyNukeOptions = {}): NukeResult {
  const planned = planNukeThirdParty(readProfileState(dir, profile))
  writeProfileState(planned.next)
  const logs = [...planned.logs]
  if (options.reconcile !== false) {
    logs.push(...reconcileRemovedPackages(dir, planned.removed, options))
  }
  logs.push(...stripHomePatchThirdParty(options.homePatchPath, planned.removed))
  return { ...planned, logs }
}
