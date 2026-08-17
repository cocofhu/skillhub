/**
 * Baseline vs third-party classification for Harness profile recovery.
 * Default strategy is never unload-all (including core/ui/settings).
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

export function normalizePluginName(raw: unknown): string {
  return String(raw ?? '').trim().replace(/^['"]|['"]$/g, '')
}

export function isBaselinePlugin(name: unknown): boolean {
  const n = normalizePluginName(name)
  if (!n) return false
  if ((BASELINE_BUNDLE_PACKAGES as readonly string[]).includes(n)) return true
  if (n.startsWith('@deepseek-ai/')) return true
  if (BASELINE_PLUGIN_IDS.has(n)) return true
  return false
}

export function isThirdPartyPlugin(name: unknown): boolean {
  const n = normalizePluginName(name)
  if (!n) return false
  return !isBaselinePlugin(n)
}

export function classifyPluginNames(names: readonly unknown[]): {
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
    if (isBaselinePlugin(n)) baseline.push(n)
    else thirdParty.push(n)
  }
  return { thirdParty, baseline }
}
