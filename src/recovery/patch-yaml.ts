import { isThirdPartyPlugin, normalizePluginName } from './baseline.js'

export interface PatchInsert {
  id?: string
  name?: string
  extra: string[]
}

export interface PatchItem {
  kind: 'insert' | 'entry'
  raw: string
  id?: string
  name?: string
  inserts: PatchInsert[]
}

export interface PatchDoc {
  preamble: string
  items: PatchItem[]
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

function field(line: string, key: string): string | undefined {
  const match = new RegExp(`^\\s*${key}:\\s*(.*)$`).exec(line)
  if (!match) return undefined
  const value = stripQuotes(match[1] || '')
  return value || undefined
}

/** Split a YAML array document into column-0 `- ` items. */
export function splitTopLevelItems(yaml: string): { preamble: string; chunks: string[] } {
  const lines = yaml.replace(/\r\n/g, '\n').split('\n')
  const preamble: string[] = []
  const chunks: string[] = []
  let current: string[] | undefined
  for (const line of lines) {
    if (current === undefined) {
      if (/^- /.test(line)) {
        current = [line]
      } else {
        preamble.push(line)
      }
      continue
    }
    if (/^- /.test(line)) {
      chunks.push(current.join('\n'))
      current = [line]
    } else {
      current.push(line)
    }
  }
  if (current) chunks.push(current.join('\n'))
  return { preamble: preamble.join('\n').replace(/\n+$/, ''), chunks }
}

function parseInserts(chunk: string): PatchInsert[] {
  const lines = chunk.split('\n')
  const inserts: PatchInsert[] = []
  let current: PatchInsert | undefined
  for (const line of lines) {
    if (/^\s{2,}- /.test(line)) {
      if (current) inserts.push(current)
      current = { extra: [line], id: field(line.replace(/^\s+-\s+/, ''), 'id') || field(line, 'id') }
      const inlineName = field(line.replace(/^\s+-\s+/, ''), 'name')
      if (inlineName) current.name = inlineName
      continue
    }
    if (!current) continue
    current.extra.push(line)
    const id = field(line, 'id')
    const name = field(line, 'name')
    if (id) current.id = id
    if (name) current.name = name
  }
  if (current) inserts.push(current)
  return inserts
}

export function parsePatchItem(chunk: string): PatchItem {
  const trimmed = chunk.trimEnd()
  const first = trimmed.split('\n')[0] || ''
  if (/^- insert:\s*$/.test(first) || /^- insert:\s/.test(first)) {
    return { kind: 'insert', raw: trimmed, inserts: parseInserts(trimmed) }
  }
  const lines = trimmed.split('\n')
  let id: string | undefined
  let name: string | undefined
  for (const line of lines) {
    const lineId = field(line.replace(/^- /, ''), 'id') || field(line, 'id')
    const lineName = field(line.replace(/^- /, ''), 'name') || field(line, 'name')
    if (lineId && !id) id = lineId
    if (lineName && !name) name = lineName
  }
  return { kind: 'entry', raw: trimmed, id, name, inserts: [] }
}

export function parsePatchList(yaml: string): PatchDoc {
  const text = yaml.replace(/\r\n/g, '\n')
  const compact = text.replace(/^\s*#.*$/gm, '').trim()
  if (!compact || compact === '[]') {
    const preamble = text.replace(/\n*\[\]\s*$/, '').replace(/\n+$/, '')
    return { preamble, items: [] }
  }
  const { preamble, chunks } = splitTopLevelItems(text)
  return { preamble, items: chunks.filter((c) => c.trim()).map(parsePatchItem) }
}

export function listPatchPluginNames(yaml: string): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  const add = (value?: string) => {
    const n = normalizePluginName(value)
    if (!n || seen.has(n)) return
    seen.add(n)
    names.push(n)
  }
  for (const item of parsePatchList(yaml).items) {
    add(item.name)
    add(item.id)
    for (const insert of item.inserts) {
      add(insert.name)
      add(insert.id)
    }
  }
  return names
}

function serializeInserts(inserts: PatchInsert[]): string {
  const lines = ['- insert:']
  for (const insert of inserts) {
    if (insert.extra.length) {
      lines.push(...insert.extra)
      continue
    }
    if (insert.id) lines.push(`    - id: ${insert.id}`)
    if (insert.name) lines.push(`      name: ${insert.name}`)
  }
  return lines.join('\n')
}

export function serializePatchList(doc: PatchDoc): string {
  const body = doc.items.length
    ? doc.items.map((item) => {
      if (item.kind === 'insert') return serializeInserts(item.inserts)
      return item.raw
    }).join('\n')
    : '[]'
  const preamble = doc.preamble.replace(/\n+$/, '')
  if (preamble) return `${preamble}\n${body}\n`
  return `${body}\n`
}

export function stripThirdPartyFromPatch(
  yaml: string,
  isThirdParty: (name: string) => boolean = isThirdPartyPlugin,
): string {
  const doc = parsePatchList(yaml)
  const next: PatchItem[] = []
  for (const item of doc.items) {
    if (item.kind === 'insert') {
      const inserts = item.inserts.filter((row) => {
        const names = [row.name, row.id].map(normalizePluginName).filter(Boolean)
        if (!names.length) return true
        return names.every((n) => !isThirdParty(n))
      })
      if (!inserts.length) continue
      next.push({ ...item, inserts })
      continue
    }
    const names = [item.name, item.id].map(normalizePluginName).filter(Boolean)
    if (names.length && names.every((n) => isThirdParty(n))) continue
    next.push(item)
  }
  return serializePatchList({ preamble: doc.preamble, items: next })
}
