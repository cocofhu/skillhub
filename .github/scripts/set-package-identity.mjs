#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const NAMES = ['skillhub-plugin', '@cocofhu/skillhub']
const name = process.argv[2]
if (!NAMES.includes(name)) {
  console.error(`usage: set-package-identity.mjs <${NAMES.join('|')}>`)
  process.exit(1)
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
pkg.name = name
writeFileSync('package.json', `${JSON.stringify(pkg, null, 2)}\n`)

function rewriteClient(path) {
  if (!existsSync(path)) return
  const next = readFileSync(path, 'utf8').replace(/id: "[^"]+"/, `id: "${name}"`)
  writeFileSync(path, next)
}

rewriteClient('src/client.js')
rewriteClient('lib/client.js')

const patch = readFileSync('cordis.patch.yml', 'utf8').replace(/name: '[^']+'/, `name: '${name}'`)
writeFileSync('cordis.patch.yml', patch)

console.log(`ok package identity ${name}`)
