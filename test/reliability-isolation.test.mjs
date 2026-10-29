import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { installAssembleGuard } from '../lib/identity.js'
import { allowPluginRequest } from '../lib/request-origin.js'
import { RedteamStore, dispatch } from '../lib/redteam/store-core.js'
import { bindings, bindingKeyOf, resolveEngagement } from '../lib/redteam/session-bindings.js'
import { noteClaimedMessage, resolveSubagentRoleText } from '../lib/redteam/role-section.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-purge-isolation-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = root
  bindings.clear()
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    bindings.clear()
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + 'dsh-purge-isolation-'))
    fs.rmSync(root, { recursive: true, force: true })
  })
  return root
}

test('native assembly errors reach the caller with the original error', async () => {
  const error = new Error('fixture assembly failure'), prompt = { assemble: async () => { throw error } }
  const dispose = installAssembleGuard(prompt, value => value)
  await assert.rejects(prompt.assemble(), value => value === error)
  dispose()
})

test('root disposal restores the native method and repeated installation remains idempotent', async () => {
  let calls = 0
  const native = async () => ({ contexts: ['required'], tools: ['fixture-tool'] })
  const prompt = { assemble: native }, rewrite = value => { calls++; return value }
  const dispose = installAssembleGuard(prompt, rewrite)
  for (let i = 0; i < 100; i++) assert.equal(installAssembleGuard(prompt, rewrite), dispose)
  assert.deepEqual(await prompt.assemble(), { contexts: ['required'], tools: ['fixture-tool'] })
  assert.equal(calls, 1)
  dispose(); dispose()
  assert.equal(prompt.assemble, native)
  await prompt.assemble()
  assert.equal(calls, 1)
})

test('disposing an old owner does not detach another owner or overwrite a newer native method', async () => {
  const prompt = { assemble: async () => 'initial' }
  const old = installAssembleGuard(prompt, value => value + ':old')
  const current = installAssembleGuard(prompt, value => value + ':current')
  old()
  assert.equal(await prompt.assemble(), 'initial:current')
  const replacement = async () => 'replacement'
  prompt.assemble = replacement
  assert.equal(await prompt.assemble(), 'replacement:current')
  current()
  assert.equal(prompt.assemble, replacement)
})

test('restores accessor/prototype/non-configurable writable services and respects external replacements', async () => {
  const native = async () => 'native'
  const descriptor = { configurable: true, get: () => new Proxy(native, {}) }
  const accessor = Object.defineProperty({}, 'assemble', descriptor)
  const inherited = Object.create({ assemble: native })
  const writable = Object.defineProperty({}, 'assemble', { value: native, writable: true, configurable: false })
  for (const prompt of [accessor, inherited, writable]) {
    const before = Object.getOwnPropertyDescriptor(prompt, 'assemble')
    const dispose = installAssembleGuard(prompt, value => value + ':rewritten')
    assert.equal(await prompt.assemble(), 'native:rewritten')
    dispose()
    assert.deepEqual(Object.getOwnPropertyDescriptor(prompt, 'assemble'), before)
  }
  const prompt = { assemble: native }, dispose = installAssembleGuard(prompt, value => value)
  const replacement = async () => 'external'
  Object.defineProperty(prompt, 'assemble', { value: replacement, configurable: true })
  dispose()
  assert.equal(prompt.assemble, replacement)
})

test('root plugin cleanup removes its global hook and also disposes a replaced service wrapper', async t => {
  fixture(t)
  const { installIdentityOverride } = await import('../lib/index.js')
  const cleanups = [], handlers = new Map()
  const native = async () => ({ sections: [], contexts: [], tools: [] })
  const ctx = {
    systemPrompt: { assemble: native },
    on: (event, handler) => { handlers.set(event, handler); return () => handlers.delete(event) },
    effect: effect => { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup) },
  }
  const previousHook = globalThis.__dshPurgePrepareAssemble
  t.after(() => {
    for (const cleanup of cleanups.reverse()) cleanup()
    if (previousHook === undefined) delete globalThis.__dshPurgePrepareAssemble
    else globalThis.__dshPurgePrepareAssemble = previousHook
  })
  installIdentityOverride(ctx, {})
  const hook = globalThis.__dshPurgePrepareAssemble
  assert.equal(typeof hook, 'function')
  Object.defineProperty(ctx.systemPrompt, 'assemble', { value: native, writable: true, configurable: true })
  hook(ctx)
  const error = new Error('downstream fixture failure')
  await assert.rejects(handlers.get('system-prompt/assemble')({}, {}, async () => { throw error }), value => value === error)
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  assert.equal(globalThis.__dshPurgePrepareAssemble, undefined)
  assert.equal(ctx.systemPrompt.assemble, native)
  assert.equal(hook(ctx), null)
})

test('storage rejects path-like IDs while ordinary and Unicode projects still save/read correctly', t => {
  const root = fixture(t), store = new RedteamStore(path.join(root, 'store'))
  try {
    for (const id of ['../../outside', '..\\outside', '/absolute', 'C:\\outside', 'A:stream', '.', '..', 'CON', 'trailing.', 'a\0b']) {
      assert.throws(() => store.savePrompt(id, 'plan', 'fixture'), /invalid engagement id/)
      const result = dispatch(store, { op: 'savePrompt', engagement: id, role: 'plan', content: 'fixture' })
      assert.equal(result.ok, false, id)
      assert.match(result.error, /invalid engagement id/)
    }
    for (const id of ['project-A', '项目一']) {
      assert.equal(dispatch(store, { op: 'savePrompt', engagement: id, role: 'plan', content: 'neutral fixture' }).ok, true)
      assert.equal(fs.readFileSync(store.promptPathOf(id, 'plan.md'), 'utf8'), 'neutral fixture')
    }
    assert.throws(() => store.savePrompt('project-A', '__proto__', 'fixture'), /unknown role/)
    assert.equal(fs.existsSync(path.join(root, 'outside')), false)
  } finally { store.close() }
})

test('storage refuses project and agents junctions that leave the project root', t => {
  const root = fixture(t), store = new RedteamStore(path.join(root, 'store'))
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside)
  try {
    fs.symlinkSync(outside, path.join(store.engagementsDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => store.savePrompt('linked', 'plan', 'fixture'), /outside allowed root/)
    const project = store.dirOf('ordinary'); fs.mkdirSync(project)
    fs.symlinkSync(outside, path.join(project, 'agents'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => store.savePrompt('ordinary', 'plan', 'fixture'), /outside allowed root/)
    assert.deepEqual(fs.readdirSync(outside), [])
  } finally { store.close() }
})

function request(headers = {}, socket = {}) {
  return { headers: { host: '127.0.0.1:12345', 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1', ...socket } }
}
test('cross-site requests are rejected even over loopback with a client header', () => {
  assert.equal(allowPluginRequest(request({ origin: 'https://untrusted.invalid', 'x-dsh-purge-client': '1' })), false)
  assert.equal(allowPluginRequest(request({ 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(allowPluginRequest(request({ origin: 'http://127.0.0.1:12345', 'content-type': 'text/plain' })), false)
  assert.equal(allowPluginRequest(request({ origin: 'http://127.0.0.1:54321' })), false)
  assert.equal(allowPluginRequest(request({ origin: 'https://127.0.0.1:12345' })), false)
})
test('same-origin browser, desktop opaque-origin bridge and local CLI remain supported', () => {
  assert.equal(allowPluginRequest(request({ origin: 'http://127.0.0.1:12345' })), true)
  assert.equal(allowPluginRequest(request({})), true)
  for (const origin of ['null', 'app://dsh', 'file://']) {
    assert.equal(allowPluginRequest(request({ origin })), false)
    assert.equal(allowPluginRequest(request({ origin, 'x-dsh-purge-client': '1' })), true)
    assert.equal(allowPluginRequest(request({ origin, 'x-dsh-purge-client': '1' }, { remoteAddress: '192.0.2.1' })), false)
  }
  assert.equal(allowPluginRequest(request({ host: 'example.test', origin: 'https://example.test' }, { encrypted: true })), true)
})

function roleFixture(root, id) {
  const folder = path.join(root, 'redteam', 'engagements', id, 'agents')
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(path.join(folder, 'recon.md'), `Neutral project ${id} note.`)
}
test('one child session retains its role project when global selection changes', t => {
  const root = fixture(t)
  roleFixture(root, 'A'); roleFixture(root, 'B')
  const current = path.join(root, 'redteam', 'current'); fs.writeFileSync(current, 'A')
  const agent = { id: 'fixture-agent', session: { id: 'fixture-child', header: { agentPreset: 'redteam', origin: 'subagent' } } }
  noteClaimedMessage({ agent, message: { content: 'redteamRole: recon' } })
  assert.equal(resolveSubagentRoleText({ agent }), 'Neutral project A note.')
  fs.writeFileSync(current, 'B')
  assert.equal(resolveSubagentRoleText({ agent }), 'Neutral project A note.')
})
test('role selection and tool dispatch share the parent binding and explicit rebinding', t => {
  const root = fixture(t)
  roleFixture(root, 'A'); roleFixture(root, 'B')
  fs.writeFileSync(path.join(root, 'redteam', 'current'), 'B')
  const parent = { id: 'fixture-parent', header: { agentPreset: 'redteam' } }
  const agent = { session: { id: 'fixture-child-bound', header: { parentSession: parent.id, agentPreset: 'redteam', origin: 'subagent' }, store: { get: () => parent } } }
  bindings.set(parent.id, 'A')
  noteClaimedMessage({ agent, message: { content: 'redteamRole: recon' } })
  assert.equal(bindingKeyOf({ agent }).rootId, parent.id)
  assert.equal(resolveEngagement({}, { agent }), 'A')
  assert.equal(resolveSubagentRoleText({ agent }), 'Neutral project A note.')
  bindings.set(parent.id, 'B')
  assert.equal(resolveSubagentRoleText({ agent }), 'Neutral project B note.')
})
