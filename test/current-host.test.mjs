import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installAssembleGuard } from '../lib/identity.js'
import { extractAsar, readAsarJson } from '../lib/extract-asar.js'
import { inspectHostRuntime } from '../lib/host-runtime.js'
import { repairSelectedDefaultInYaml, removeStaleAgentPresetDir } from '../lib/preset-default.js'
import { windowsDesktopPids } from '../lib/desktop-processes.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-current-host-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function archive(filename, files, content = Buffer.alloc(0)) {
  const json = Buffer.from(JSON.stringify({ files }))
  const headerSize = 8 + Math.ceil((json.length + 1) / 4) * 4
  const header = Buffer.alloc(8 + headerSize)
  header.writeUInt32LE(4, 0)
  header.writeUInt32LE(headerSize, 4)
  header.writeUInt32LE(headerSize - 4, 8)
  header.writeUInt32LE(json.length, 12)
  json.copy(header, 16)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, Buffer.concat([header, content]))
}

test('modern host retains native finalization and the public assembly event owns rewrites', () => {
  const native = async () => ({ sections: [], tools: ['provider-owned'] })
  const prompt = { assemble: native, refreshContext() {}, tools() {}, section() {} }
  assert.equal(installAssembleGuard(prompt, () => { throw new Error('must not wrap') }), false)
  assert.equal(prompt.assemble, native)
})

test('Windows process lookup explicitly emits UTF-8 for paths containing Chinese', () => {
  const exe = 'D:\\应用\\DeepSeek Harness.exe'
  const pids = windowsDesktopPids(exe, (_program, args, options) => {
    assert.ok(args.at(-1).includes('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)'))
    assert.equal(options.env.DSH_PURGE_TARGET_EXE, exe)
    assert.equal(options.encoding, 'utf8')
    return JSON.stringify([{ ProcessId: 1234, ExecutablePath: exe }])
  })
  assert.deepEqual(pids, [1234])
})

test('sealed host version comes from its archive rather than a stale extracted tree', t => {
  const root = fixture(t), exe = path.join(root, 'DeepSeek Harness.exe')
  const bytes = Buffer.from(JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.2.2-rc.1' }))
  archive(path.join(root, 'resources', 'app.asar'), { dsh: { files: { 'package.json': { size: bytes.length, offset: '0' } } } }, bytes)
  const stale = path.join(root, 'resources/app/dsh/package.json')
  fs.mkdirSync(path.dirname(stale), { recursive: true })
  fs.writeFileSync(stale, JSON.stringify({ name: '@deepseek-ai/dsh-desktop-runtime', version: '0.1.0' }))
  const result = inspectHostRuntime({ desktopExe: exe })
  assert.equal(result.version, '0.2.2-rc.1')
  assert.equal(result.sealed, true)
  assert.ok(result.source.includes('app.asar/'))
})

test('unknown or corrupt host identity remains unknown without breaking status', t => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, 'resources'), { recursive: true })
  fs.writeFileSync(path.join(root, 'resources/app.asar'), 'corrupt fixture')
  assert.equal(inspectHostRuntime({ desktopExe: path.join(root, 'host.exe') }).version, '')
  assert.equal(inspectHostRuntime({ desktopExe: '' }).version, '')
})

test('ASAR traversal and invalid ranges fail before writing any extracted files', t => {
  const root = fixture(t), input = path.join(root, 'fixture.asar'), output = path.join(root, 'out')
  for (const name of ['..', '../escape', 'C:escape', 'bad\\name', '/absolute']) {
    archive(input, { good: { size: 0, offset: '0' }, [name]: { size: 0, offset: '0' } })
    assert.throws(() => extractAsar(input, output), /unsafe asar/)
    assert.equal(fs.existsSync(output), false)
  }
  for (const info of [{ size: -1, offset: '0' }, { size: 5, offset: '-1' }, { size: 50, offset: '0' }]) {
    archive(input, { good: { size: 0, offset: '0' }, bad: info })
    assert.throws(() => extractAsar(input, output), /range outside archive/)
    assert.equal(fs.existsSync(output), false)
  }
})

test('ASAR extraction refuses an existing directory link outside the destination', t => {
  const root = fixture(t), input = path.join(root, 'fixture.asar'), output = path.join(root, 'out'), outside = path.join(root, 'outside')
  fs.mkdirSync(output)
  fs.mkdirSync(outside)
  fs.symlinkSync(outside, path.join(output, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  archive(input, { linked: { files: { escaped: { size: 0, offset: '0' } } } })
  assert.throws(() => extractAsar(input, output), /outside allowed root/)
  assert.equal(fs.existsSync(path.join(outside, 'escaped')), false)
})

test('valid archive extracts bytes and reads bounded JSON without extraction', t => {
  const root = fixture(t), input = path.join(root, 'fixture.asar'), output = path.join(root, 'out')
  const data = Buffer.from('{"version":"fixture"}')
  archive(input, { 'package.json': { size: data.length, offset: '0' } }, data)
  assert.deepEqual(readAsarJson(input, 'package.json'), { version: 'fixture' })
  assert.equal(fs.existsSync(output), false)
  assert.equal(extractAsar(input, output), 1)
  assert.equal(fs.readFileSync(path.join(output, 'package.json'), 'utf8'), data.toString())
  assert.throws(() => readAsarJson(input, '../package.json'), /unsafe asar lookup/)
})

test('selected default cleanup keeps comments, unknown presets and quoted prose intact', () => {
  const source = '# selectedDefault: redteam\nselectedDefault: redteam-extra\ntext: "selectedDefault: redteam"\n'
  assert.deepEqual(repairSelectedDefaultInYaml(source), { text: source, changed: false })
  assert.equal(repairSelectedDefaultInYaml("  selectedDefault: 'project/redteam' # keep\n").text, "  selectedDefault: 'standard' # keep\n")
})

test('preset cleanup rejects traversal and external junctions', t => {
  const root = fixture(t), home = path.join(root, 'home'), outside = path.join(root, 'outside')
  fs.mkdirSync(path.join(home, '.agent-presets'), { recursive: true })
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'keep'), 'user data')
  assert.equal(removeStaleAgentPresetDir(home, '../../outside'), false)
  fs.symlinkSync(outside, path.join(home, '.agent-presets', 'fixture'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(removeStaleAgentPresetDir(home, 'fixture'), false)
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'user data')
})
