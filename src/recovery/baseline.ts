/**
 * Baseline vs third-party classification for Harness profile recovery.
 * Default strategy is never unload-all (including core/ui/settings fibers).
 *
 * npm dependencies only keep BASELINE_BUNDLE_PACKAGES — short ids like
 * "settings" must NOT protect a third-party package of the same name.
 */

export const BASELINE_BUNDLE_PACKAGES = [
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
] as const

/** In-box plugin ids that ride inside baseline bundles, not profile dependencies. */
export const BASELINE_PLUGIN_IDS = new Set([
  'core',
  'ui',
  'settings',
  'webserver',
  'web-runtime',
  'frontend-static',
  'modules',
  'connection',
  'app-shell',
  'loader',
  'include',
  'timer',
  'hmr',
  'plugin-inventory',
  'apiproxy',
  'directory-picker',
])

export type PluginNameKind = 'dependency' | 'bundle' | 'plugin-id' | 'auto'

export function normalizePluginName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^['"]|['"]$/g, '')
}

/** Profile package.json dependency whitelist — packages only, never short fiber ids. */
export function isBaselineDependency(name: unknown): boolean {
  const n = normalizePluginName(name)
  if (!n) return false
  return (BASELINE_BUNDLE_PACKAGES as readonly string[]).includes(n)
}

/** Cordis patch / fiber ids that belong to the in-box baseline. */
export function isBaselinePluginId(name: unknown): boolean {
  const n = normalizePluginName(name)
  if (!n) return false
  if (isBaselineDependency(n)) return true
  return BASELINE_PLUGIN_IDS.has(n)
}

/**
 * Bundles listed on the profile: keep only known baseline packages.
 * Short ids and arbitrary scoped packages are treated as third-party layers.
 */
export function isBaselineBundle(name: unknown): boolean {
  return isBaselineDependency(name)
}

/** @deprecated Prefer kind-aware helpers; kept for patch helpers that see fiber ids. */
export function isBaselinePlugin(name: unknown): boolean {
  return isBaselinePluginId(name)
}

export function isThirdPartyPlugin(name: unknown, kind: PluginNameKind = 'auto'): boolean {
  const n = normalizePluginName(name)
  if (!n) return false
  if (kind === 'dependency' || kind === 'bundle') return !isBaselineDependency(n)
  if (kind === 'plugin-id') return !isBaselinePluginId(n)
  // auto: scoped baseline packages OR known fiber ids; bare npm names are third-party
  if (isBaselineDependency(n)) return false
  if (BASELINE_PLUGIN_IDS.has(n)) return false
  return true
}

export function classifyPluginNames(
  names: readonly unknown[],
  kind: PluginNameKind = 'auto',
): {
  thirdParty: string[]
  baseline: string[]
} {
  const thirdParty: string[] = []
  const baseline: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const n = normalizePluginName(name)
    if (!n || seen.has(n)) continue
    seen.add(n)
    if (isThirdPartyPlugin(n, kind)) thirdParty.push(n)
    else baseline.push(n)
  }
  return { thirdParty, baseline }
}
