#!/usr/bin/env node
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyNukeThirdParty, planNukeThirdParty, readProfileState } from './nuke-third-party.js'
import { dshHome } from '../config-store.js'

export function parseArgs(argv: string[]): { command: string; profile: string; dryRun: boolean } {
  const args = [...argv]
  const command = args.shift() || ''
  let profile = process.env.DSH_PROFILE || 'web'
  let dryRun = false
  while (args.length) {
    const token = args.shift() as string
    if (token === '--profile') profile = args.shift() || profile
    else if (token.startsWith('--profile=')) profile = token.slice('--profile='.length)
    else if (token === '--dry-run') dryRun = true
  }
  return { command, profile, dryRun }
}

export function runCli(argv: string[], log: (text: string) => void = console.log): number {
  const { command, profile, dryRun } = parseArgs(argv)
  if (command !== 'nuke-third-party') {
    log('usage: skillhub-recovery nuke-third-party [--profile web] [--dry-run]')
    return command ? 2 : 0
  }
  try {
    const dir = process.env.DSH_PROFILE_DIR || join(dshHome(), 'profiles', profile)
    const result = dryRun ? planNukeThirdParty(readProfileState(dir, profile)) : applyNukeThirdParty(dir, profile)
    log(JSON.stringify({
      ok: true,
      dryRun,
      profile: result.profile,
      removed: result.removed,
      kept: result.kept,
      logs: result.logs,
      restartRequired: !dryRun,
    }, null, 2))
    if (!dryRun) log('Restart dsh web and hard-refresh the browser to enter safe mode.')
    return 0
  } catch (err) {
    log(err instanceof Error ? err.message : String(err))
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (entry === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2))
}
