import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateRawSync } from 'node:zlib'
import { withDefaults } from '../config-store.js'
import { installSkill, listInstalled, parseFrontmatter, parseVersion, safeRelPath, skillDir, uninstallSkill } from '../install.js'
import { unzipToFiles } from '../unzip.js'
import type { PluginConfig } from '../types.js'

test('safeRelPath rejects traversal', () => {
  assert.equal(safeRelPath('SKILL.md'), 'SKILL.md')
  assert.equal(safeRelPath('references/api.md'), 'references/api.md')
  assert.throws(() => safeRelPath('../etc/passwd'), /不安全路径/)
  assert.throws(() => safeRelPath('/abs'), /不安全路径/)
  assert.throws(() => safeRelPath('foo/../bar'), /不安全路径/)
  assert.throws(() => safeRelPath(''), /空路径/)
})

test('parseVersion strips v prefix and rejects junk', () => {
  assert.equal(parseVersion(''), '')
  assert.equal(parseVersion('v1.0.0'), '1.0.0')
  assert.equal(parseVersion('1.2.3'), '1.2.3')
  assert.throws(() => parseVersion('../x'), /无效版本/)
  assert.throws(() => parseVersion('1 0'), /无效版本/)
})

test('install fetches specified version via zip download', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillhub-ver-'))
  const urls: string[] = []
  const zip = makeZip({
    'SKILL.md': '---\nname: tianji\nversion: 1.0.0\n---\n',
  })
  const result = await installSkill('tianji', testCfg(dir), {
    fetchBytes: async (url: string) => {
      urls.push(String(url))
      return { body: zip, contentType: 'application/zip' }
    },
  }, undefined, 'v1.0.0')
  assert.equal(urls.length, 1)
  assert.match(urls[0], /\/api\/v1\/download\?slug=tianji&version=1\.0\.0&source=dsh$/)
  assert.equal(result.version, '1.0.0')
  await rm(dir, { recursive: true, force: true })
})

test('skillDir stays inside skills root', () => {
  const root = '/tmp/skills-root'
  assert.equal(skillDir(root, 'pdf-ocr-md'), join(root, 'pdf-ocr-md'))
  assert.throws(() => skillDir(root, '../escape'), /无效 slug/)
})

test('parseFrontmatter reads name and description', () => {
  const meta = parseFrontmatter('---\nname: demo\ndescription: "hello"\nversion: 1.0.0\n---\n# body\n')
  assert.equal(meta.name, 'demo')
  assert.equal(meta.description, 'hello')
  assert.equal(meta.version, '1.0.0')
})

test('install requires SKILL.md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillhub-test-'))
  const cfg = testCfg(dir)
  const zip = makeZip({ 'notes.txt': 'x' })
  await assert.rejects(
    () => installSkill('empty-skill', cfg, {
      fetchBytes: async () => ({ body: zip, contentType: 'application/zip' }),
    }),
    /缺少 SKILL.md/,
  )
  await rm(dir, { recursive: true, force: true })
})

test('atomic install and uninstall', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillhub-test-'))
  const cfg = testCfg(dir)
  const zip = makeZip({
    'SKILL.md': '---\nname: demo-skill\ndescription: test skill\n---\n# Demo\n',
    'references/api.md': '# api\n',
  })
  const result = await installSkill('demo-skill', cfg, {
    fetchBytes: async () => ({ body: zip, contentType: 'application/zip' }),
  })
  assert.equal(result.slug, 'demo-skill')
  assert.equal(result.name, 'demo-skill')
  assert.equal(result.files, 2)
  const skillMd = await readFile(join(dir, 'demo-skill', 'SKILL.md'), 'utf8')
  assert.match(skillMd, /test skill/)
  const listed = await listInstalled(dir)
  assert.equal(listed.length, 1)
  assert.equal(listed[0].slug, 'demo-skill')
  await uninstallSkill('demo-skill', dir)
  assert.equal((await listInstalled(dir)).length, 0)
  await rm(dir, { recursive: true, force: true })
})

test('uninstall refuses directory without SKILL.md', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillhub-test-'))
  await assert.rejects(() => uninstallSkill('missing', dir), /未安装或不含 SKILL.md/)
  await rm(dir, { recursive: true, force: true })
})

test('install uses zip download API', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'skillhub-test-'))
  const cfg = testCfg(dir)
  const zip = makeZip({
    'pack/SKILL.md': '---\nname: zip-skill\ndescription: from zip\n---\n',
    'pack/notes.md': 'hi',
  })
  const result = await installSkill('zip-skill', cfg, {
    fetchBytes: async (url) => {
      assert.match(String(url), /\/api\/v1\/download\?slug=zip-skill&source=dsh$/)
      return { body: zip, contentType: 'application/zip' }
    },
  })
  assert.equal(result.name, 'zip-skill')
  const listed = await listInstalled(dir)
  assert.equal(listed[0].name, 'zip-skill')
  await rm(dir, { recursive: true, force: true })
})

test('unzipToFiles reads stored and deflated entries', () => {
  const files = unzipToFiles(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'world' }))
  assert.equal(files['a.txt'].toString(), 'hello')
  assert.equal(files['dir/b.txt'].toString(), 'world')
})

test('unzipToFiles reads data-descriptor zip from central directory', () => {
  const files = unzipToFiles(makeDescriptorZip({
    'SKILL.md': '---\nname: report\n---\nbody',
    'references/t.md': 'tpl',
  }))
  assert.equal(files['SKILL.md'].toString(), '---\nname: report\n---\nbody')
  assert.equal(files['references/t.md'].toString(), 'tpl')
})

function testCfg(skillsDir: string): PluginConfig {
  return withDefaults({ skillsDir, timeoutMs: 5000, userAgent: 'test' })
}

function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = []
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const compressed = deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0, 6)
    header.writeUInt16LE(8, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt32LE(0, 14)
    header.writeUInt32LE(compressed.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBuf, compressed)
  }
  chunks.push(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
  return Buffer.concat(chunks)
}

function makeDescriptorZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text)
    const compressed = deflateRawSync(raw)
    const nameBuf = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 6)
    local.writeUInt16LE(8, 8)
    local.writeUInt16LE(nameBuf.length, 26)
    const desc = Buffer.alloc(16)
    desc.writeUInt32LE(0x08074b50, 0)
    desc.writeUInt32LE(compressed.length, 8)
    desc.writeUInt32LE(raw.length, 12)
    const chunk = Buffer.concat([local, nameBuf, compressed, desc])
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(chunk)
    centrals.push(central, nameBuf)
    offset += chunk.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  const n = Object.keys(files).length
  eocd.writeUInt16LE(n, 8)
  eocd.writeUInt16LE(n, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}
