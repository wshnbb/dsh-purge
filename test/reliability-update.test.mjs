import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import test from 'node:test'
import { safeUpdateRef, hideListedVersion, versionIsNewer } from '../lib/update.js'
import { deployPackage, packageEntries } from '../lib/update-files.js'
import { extractZipBuffer } from '../lib/zip-extract.js'
import { selectWindowsDesktopPids, windowsDesktopPids } from '../lib/desktop-processes.js'

const stable = 'compat/dsh-0.2.1-rc.2'
const updateSource = fs.readFileSync(new URL('../lib/update.js', import.meta.url), 'utf8')
function functionFrom(start, end, scope) {
  const first = updateSource.indexOf(start), last = updateSource.indexOf(end, first)
  assert.ok(first >= 0 && last > first)
  return vm.runInNewContext('(' + updateSource.slice(first, last).replace(/^export /, '').trim() + ')', scope)
}

test('configured stable branch is accepted and visible without opening arbitrary refs', () => {
  assert.equal(safeUpdateRef(stable), stable)
  assert.equal(hideListedVersion({ ref: stable, id: stable, channel: 'stable', version: '1.1.71-wshnbb.2' }), false)
  assert.equal(hideListedVersion({ ref: 'v1.2.0-rc.2', channel: 'beta' }), true)
  for (const input of ['../../main', '--upload-pack=anything', 'other/branch', 'main;command', '']) assert.equal(safeUpdateRef(input), '')
})

test('default update request reaches apply with the configured compatibility branch', async () => {
  const handler = functionFrom('export async function handleUpdateOp(', '\nexport async function autoUpdateIfNeeded(', {
    STABLE_REF: stable, BETA_REF: 'beta', safeUpdateRef,
    readChannelState: () => ({ channel: 'stable' }), currentChannelRef: () => stable,
    isBetaName: ref => ref.includes('rc.'), planUpdates: () => ['fixture'],
    applyUpdate: async (_jobs, options) => ({ ref: options.ref, channel: options.channel, force: options.force }),
  })
  const result = await handler({})
  assert.equal(result.ref, stable)
  assert.equal(result.channel, 'stable')
  assert.equal(result.force, undefined)
})

test('version ordering compares prerelease identifiers numerically and ignores build metadata', () => {
  for (const [a, b, expected] of [
    ['1.1.71-beta.10', '1.1.71-beta.2', true], ['1.1.71-beta.2', '1.1.71-beta.10', false],
    ['1.0.0', '1.0.0-rc.1', true], ['1.0.0-rc.1', '1.0.0', false],
    ['1.0.0-beta.2', '1.0.0-beta', true], ['1.0.0-beta', '1.0.0-beta.2', false],
    ['1.0.0-2', '1.0.0-alpha', false], ['1.0.0-alpha', '1.0.0-2', true],
    ['1.0.0+two', '1.0.0+one', false], ['1.0.0-beta.2+two', '1.0.0-beta.2+one', false],
    ['2.0.0', '1.99.99', true], ['invalid', '1.0.0', false], ['1.0.0', '', true],
  ]) assert.equal(versionIsNewer(a, b), expected, `${a} vs ${b}`)
})

test('Git update refuses dirty or untracked work even if a legacy caller requests force', () => {
  let writes = 0
  const reset = functionFrom('function gitResetTo(', '\nfunction extractZip(', {
    gitTrackedDirty: () => true, runGit: () => { writes++ }, safeUpdateRef, STABLE_REF: stable,
  })
  assert.throws(() => reset('fixture', stable, { force: true }), { code: 'DSH_PURGE_DIRTY_WORKTREE' })
  assert.equal(writes, 0)
  const dirty = functionFrom('function gitTrackedDirty(', '\nlet lastUpdate', {
    HIDDEN: {}, execFileSync: (_bin, args) => {
      assert.ok(args.includes('--untracked-files=all'))
      assert.ok(!args.includes('--'))
      return '?? local-notes.txt\n'
    },
  })
  assert.equal(dirty('fixture'), true)
})

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-reliability-'))
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'dsh-purge-reliability-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}
function packageAt(root, label) {
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'dsh-purge', version: '1.1.71', files: ['lib', 'client.js', 'presets', 'skills', 'scripts'] }))
  fs.writeFileSync(path.join(root, 'client.js'), label)
  for (const directory of ['lib', 'presets', 'skills', 'scripts']) {
    fs.mkdirSync(path.join(root, directory))
    fs.writeFileSync(path.join(root, directory, directory === 'lib' ? 'index.js' : 'fixture.txt'), label)
  }
  return root
}

test('deployment updates all manifest directories, preserves local files and retains a backup', async t => {
  const root = fixture(t), source = packageAt(path.join(root, 'source'), 'new'), target = packageAt(path.join(root, 'target'), 'old')
  fs.writeFileSync(path.join(target, 'user-settings.json'), 'keep')
  fs.writeFileSync(path.join(target, 'lib', 'obsolete.js'), 'old')
  const result = await deployPackage(source, [target])
  for (const dir of ['presets', 'skills', 'scripts']) assert.equal(fs.readFileSync(path.join(target, dir, 'fixture.txt'), 'utf8'), 'new')
  assert.equal(fs.readFileSync(path.join(target, 'user-settings.json'), 'utf8'), 'keep')
  assert.equal(fs.existsSync(path.join(target, 'lib', 'obsolete.js')), false)
  assert.equal(fs.readFileSync(path.join(result.backups[0].directory, 'backup', 'lib', 'index.js'), 'utf8'), 'old')
})

test('copy failure during staging leaves the entire working installation intact', async t => {
  const root = fixture(t), source = packageAt(path.join(root, 'source'), 'new'), target = packageAt(path.join(root, 'target'), 'old')
  await assert.rejects(deployPackage(source, [target], { io: { ...fs.promises, cp: async () => { throw new Error('disk full') } } }), /原文件已保留或恢复/)
  assert.equal(fs.readFileSync(path.join(target, 'lib', 'index.js'), 'utf8'), 'old')
  assert.equal(fs.readFileSync(path.join(target, 'client.js'), 'utf8'), 'old')
})

test('a failure switching the second destination rolls back both installations', async t => {
  const root = fixture(t), source = packageAt(path.join(root, 'source'), 'new')
  const targets = [packageAt(path.join(root, 'one'), 'old-one'), packageAt(path.join(root, 'two'), 'old-two')]
  let failed = false
  const io = { ...fs.promises, rename: async (from, to) => {
    if (!failed && from.includes(path.sep + 'stage' + path.sep) && to === path.join(targets[1], 'client.js')) {
      failed = true
      throw new Error('locked destination')
    }
    return fs.promises.rename(from, to)
  } }
  await assert.rejects(deployPackage(source, targets, { io }), /原文件已保留或恢复/)
  for (const [i, name] of ['old-one', 'old-two'].entries()) {
    assert.equal(fs.readFileSync(path.join(targets[i], 'lib', 'index.js'), 'utf8'), name)
    assert.equal(fs.readFileSync(path.join(targets[i], 'client.js'), 'utf8'), name)
  }
})

test('incomplete packages and unsafe manifest entries are rejected before installation changes', async t => {
  const root = fixture(t), source = packageAt(path.join(root, 'source'), 'new'), target = packageAt(path.join(root, 'target'), 'old')
  fs.unlinkSync(path.join(source, 'lib', 'index.js'))
  await assert.rejects(deployPackage(source, [target]))
  assert.equal(fs.readFileSync(path.join(target, 'client.js'), 'utf8'), 'old')
  assert.throws(() => packageEntries({ name: 'dsh-purge', version: '1', files: ['../outside', 'lib', 'client.js'] }), /unsafe/)
})

function zip(entries) {
  const local = [], central = []; let offset = 0
  for (const name of entries) {
    const n = Buffer.from(name), h = Buffer.alloc(30), c = Buffer.alloc(46)
    h.writeUInt32LE(0x04034b50); h.writeUInt16LE(20, 4); h.writeUInt16LE(n.length, 26)
    c.writeUInt32LE(0x02014b50); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6)
    c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
    local.push(h, n); central.push(c, n); offset += h.length + n.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

test('Node ZIP fallback handles directory entries and rejects absolute/traversing names', t => {
  const root = fixture(t)
  extractZipBuffer(zip(['folder/', 'folder/file.txt', 'empty/']), root)
  assert.ok(fs.statSync(path.join(root, 'folder')).isDirectory())
  assert.ok(fs.statSync(path.join(root, 'folder', 'file.txt')).isFile())
  assert.ok(fs.statSync(path.join(root, 'empty')).isDirectory())
  for (const name of ['/absolute', '../outside', 'C:/outside']) assert.throws(() => extractZipBuffer(zip([name]), root), /路径不合法/)
})

test('Windows restart selects only the requested installation, and fails closed on lookup errors', () => {
  const exe = 'C:\\one\\DeepSeek Harness.exe'
  assert.deepEqual(selectWindowsDesktopPids([
    { ProcessId: 10, ExecutablePath: exe }, { ProcessId: 11, ExecutablePath: 'C:\\two\\DeepSeek Harness.exe' },
    { ProcessId: 12, ExecutablePath: null }, { ProcessId: 13, ExecutablePath: 'c:/ONE/DeepSeek Harness.exe' },
  ], exe), [10, 13])
  assert.deepEqual(windowsDesktopPids(exe, (_command, _args, options) => {
    assert.equal(options.env.DSH_PURGE_TARGET_EXE, exe)
    assert.equal(options.windowsHide, true)
    return JSON.stringify([{ ProcessId: 10, ExecutablePath: exe }])
  }), [10])
  assert.throws(() => windowsDesktopPids(exe, () => { throw new Error('access denied') }), /access denied/)
  assert.throws(() => selectWindowsDesktopPids([], ''), /path is required/)
})
