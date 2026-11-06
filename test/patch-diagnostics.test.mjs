import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ALL_PATCHES, applyReplacementsToText, inspectPatchFile, groupPatchesForDisplay, tallyDisplayPatches, patchStatusReady, targetFiles } from '../lib/core.js'
import { patchDisposition, summarizeDiagnostics } from '../lib/patch-diagnostics.js'

const patch = id => ALL_PATCHES.find(p => p.id === id)
test('strict targets and unreadable files cannot be hidden by another applied location', () => {
  const entries = [{ status: 'applied' }, { status: 'unmatched' }]
  assert.equal(summarizeDiagnostics(entries).status, 'applied')
  assert.equal(summarizeDiagnostics(entries, 'missing_file', { strictFiles: true }).status, 'unmatched')
  assert.equal(summarizeDiagnostics([{ status: 'applied' }, { status: 'unmatched', code: 'read-error' }]).status, 'unmatched')
})
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-patch-diagnostics-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}
function write(root, relative, content) {
  const filename = path.join(root, relative)
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  fs.writeFileSync(filename, content)
  return filename
}

test('unknown optional layouts and partial markers are not successful skips', () => {
  const p = { id: 999, optional: true, replacements: [{ pattern: 'old', replace: 'new' }], markers: ['one', 'two'] }
  assert.equal(inspectPatchFile('unknown', p).status, 'unmatched')
  assert.equal(inspectPatchFile('one', p).status, 'partial')
  assert.equal(patchStatusReady('partial', p), false)
  assert.equal(patchStatusReady('unmatched', p), false)
  assert.equal(summarizeDiagnostics([{ status: 'applied' }, { status: 'partial' }]).status, 'partial')
})

test('only positively identified cleanup and native replacement paths are resolved', () => {
  assert.equal(inspectPatchFile('official preset', patch(80)).status, 'skipped')
  assert.equal(inspectPatchFile('const p = renderPrompt(assembly);', patch(88)).status, 'skipped')
  assert.equal(inspectPatchFile('unknown', patch(88)).status, 'unmatched')
  const modern = 'this.loopCtx.tools.resolve({}); this.loopCtx.systemPrompt.assemble({});'
  for (const id of [74, 87]) assert.equal(inspectPatchFile(modern, patch(id)).status, 'superseded')
  assert.equal(inspectPatchFile('refreshContext() {} toolProviders completeSection', patch(40)).status, 'superseded')
  assert.equal(patchDisposition(patch(82), '', { aiBase: '/fixture', readText: () => 'runProfile({ profile: "desktop" })' }).status, 'superseded')
  assert.equal(patchDisposition(patch(82), '', { aiBase: '/fixture', readText: () => { throw Error('unreadable') } }), null)
})

test('merged rows retain identifiers and unresolved states are not counted ready', () => {
  const ids = [32, 53, 74, 87, 17]
  const rows = groupPatchesForDisplay(ALL_PATCHES.filter(p => ids.includes(p.id)), {
    32: 'applied', 53: 'pending', 74: 'superseded', 87: 'superseded', 17: 'partial',
  }, 'desktop', { 53: { reason: 'pending detail' } })
  assert.equal(rows.length, 2)
  assert.deepEqual(rows.find(p => p.id === 32).ids, [32, 53])
  assert.equal(rows.find(p => p.id === 32).reason, 'pending detail')
  assert.ok(rows.every(p => !p.ids.includes(74) && !p.ids.includes(87)))
  assert.deepEqual(tallyDisplayPatches(rows), { applied: 0, pending: 1, unmatched: 1, skipped: 0, total: 2, ready: 0 })
})

test('new package splits are discovered alongside legacy locations', t => {
  const root = fixture(t)
  const relative = [
    'dsh-harness-dev-context/lib/index.js', 'dsh-deliverable-file-references/lib/index.js',
    'dsh-tool-executor-ptc/lib/index.js', 'dsh-tools/lib/pipeline.js',
  ]
  for (const name of relative) write(root, name, '// fixture')
  const files = targetFiles(root, root)
  for (const [key, name] of [['web-app-lib', relative[0]], ['deliverables-prompt', relative[1]], ['dsh-tools-ptc', relative[2]], ['dsh-tools-types', relative[3]]]) {
    assert.ok([files[key]].flat().includes(path.join(root, name)), key)
  }
})

test('message guards survive indentation and line ending changes and remain idempotent', () => {
  for (const indent of ['    ', '\t\t\t\t\t']) for (const newline of ['\n', '\r\n']) {
    const source = ['return function(decision, turnEnds, phase) { for (;;) {',
      indent + 'if (turnEnds && decision.messages.length === 0) break;',
      indent + 'if (phase.step === 0 && decision.messages.length === 0) {',
      'return "complete"; } return "work"; } return "end"; }'].join(newline)
    const result = applyReplacementsToText(source, patch(67))
    const step = Function(result.text)()
    assert.equal(step({}, true, { step: 1 }), 'end')
    assert.equal(step({}, false, { step: 0 }), 'complete')
    assert.equal(step({ messages: ['message'] }, false, { step: 1 }), 'work')
    assert.equal(inspectPatchFile(result.text, patch(67)).status, 'applied')
    assert.equal(applyReplacementsToText(result.text, patch(67)).changed, false)
  }
})

test('rewind append refreshes immediately while preserving both old and new clearing logic', () => {
  for (const clear of ['this.revised.clear();', 'if (this.revised.size > 0) this.revised.clear();']) {
    const source = ['function isRewindMarker(e) { return e.rewind === true; }',
      'return class {', '  append(record) {', '    const event = record.event;',
      '    if (this.inputs.has(event.seq)) return "none";', '    ' + clear,
      '    this.inputs.set(event.seq, record);', '    return "normal";', '  }', '}'].join('\n')
    const result = applyReplacementsToText(source, patch(77))
    const Model = Function(result.text)(), instance = new Model()
    instance.inputs = new Map([[1, { event: { seq: 1 } }]])
    instance.revised = new Set(['changed'])
    instance.hasMore = false
    instance.replaceWindow = rows => { instance.refreshed = rows; return 'immediate' }
    const marker = { event: { seq: 2, rewind: true } }
    assert.equal(instance.append(marker), 'immediate')
    assert.deepEqual(instance.refreshed.map(r => r.event.seq), [1, 2])
    assert.equal(instance.append({ event: { seq: 1 } }), 'none')
    assert.equal(instance.append({ event: { seq: 3 } }), 'normal')
    assert.equal(instance.revised.size, 0)
    assert.equal(applyReplacementsToText(result.text, patch(77)).changed, false)
  }
  assert.equal(inspectPatchFile('append(record) {}', patch(77)).code, 'missing-prerequisite')
})

test('modern escalation preserves request fields and the approval result when a service exists', async () => {
  const source = ['return async function(approval, mode, justification) {',
    'const escalationDisplayReason = () => "display";', 'const outcome = await approval.approver.request({',
    '  agent: approval.agent,', '  toolName: approval.toolName,', '  callId: approval.callId,',
    '  reason: `escalate sandbox to ${mode}: ${justification}`,',
    '  displayReason: escalationDisplayReason(mode, justification),',
    '  ...approval.signal ? { signal: approval.signal } : {}', '});', 'return outcome; }'].join('\n')
  const result = applyReplacementsToText(source, patch(14)), run = Function(result.text)()
  let seen
  assert.equal(await run({ agent: {}, signal: 'signal', approver: { request: async x => { seen = x; return 'rejected' } } }, 'mode', 'reason'), 'rejected')
  assert.equal(seen.displayReason, 'display')
  assert.equal(seen.signal, 'signal')
  assert.equal(await run({}, 'mode', 'reason'), 'allowed-once')
  assert.equal(applyReplacementsToText(result.text, patch(14)).changed, false)
})

test('the new edit delegate adaptation does not alter deletion or shared version checks', () => {
  const source = ['return class {',
    '  writeIntent() { // [dsh-purge] observation bypass: writes are unconditional', '    return undefined; }',
    '  editIntent(target, actor) {', '  \treturn this.requirePresent(target, actor, "edit");', '  }',
    '  deleteIntent(target, actor) { return this.requirePresent(target, actor, "delete"); }',
    '  requirePresent() { throw Error("must read first"); }', '}'].join('\n')
  assert.equal(inspectPatchFile(source, patch(17)).status, 'partial')
  const result = applyReplacementsToText(source, patch(17)), Model = Function(result.text)(), instance = new Model()
  assert.equal(instance.editIntent({}, {}), undefined)
  assert.throws(() => instance.deleteIntent({}, {}), /must read first/)
  assert.equal(inspectPatchFile(result.text, patch(17)).status, 'applied')
})

test('the two web rules do not share a false completion signal', () => {
  const sentence = 'Do not start a replacement server unless the user asks; if one is needed, use a managed background job and verify its exact URL.'
  const source = 'const prompt = `You are interacting with the user through the DeepSeek Harness Web GUI whose URL the runtime context names. ' + sentence + '`;'
  const neutral = applyReplacementsToText(source, patch(32)).text
  assert.equal(inspectPatchFile(neutral, patch(53)).status, 'pending')
  const complete = applyReplacementsToText(neutral, patch(53)).text
  assert.equal(inspectPatchFile(complete, patch(32)).status, 'applied')
  assert.equal(inspectPatchFile(complete, patch(53)).status, 'applied')
})

test('tool approval pipeline adaptation keeps explicit rejection, cancellation and agentless decisions', async () => {
  const source = [
    'return async function(exec) { const ask = {}; const approval = this.approval;',
    '  if (approval === void 0) return {', '  \tdecision: {', '  \t\tkind: "deny",',
    '  \t\treason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`',
    '  \t},', '  \tapprovalCancelled: false', '  };',
    '  if (!exec.agent) return { decision: { kind: "deny" }, approvalCancelled: false };',
    '  const outcome = await approval.request(); switch (outcome) {',
    '    case "rejected": return { decision: { kind: "deny" }, approvalCancelled: false };',
    '    case "cancelled": return { decision: { kind: "deny" }, approvalCancelled: true };',
    '    case "unavailable": return {', '    \tdecision: {', '    \t\tkind: "deny",',
    '    \t\treason: `tool "${exec.name}" requires approval, but no approval channel is available`',
    '    \t},', '    \tapprovalCancelled: false', '    };',
    '    default: return { decision: { kind: "allow" }, approvalCancelled: false };', '  }', '}',
  ].join('\n')
  const result = applyReplacementsToText(source, patch(62)), run = Function(result.text)()
  assert.equal(inspectPatchFile(result.text, patch(62)).status, 'applied')
  for (const outcome of ['rejected', 'cancelled', 'unavailable']) {
    const host = { approval: { request: async () => outcome } }
    const response = await run.call(host, { name: 'fixture', agent: {} })
    assert.equal(response.decision.kind, outcome === 'unavailable' ? 'allow' : 'deny')
    assert.equal(response.approvalCancelled, outcome === 'cancelled')
    assert.equal((await run.call(host, { name: 'fixture' })).decision.kind, 'deny')
  }
  assert.equal((await run.call({}, { name: 'fixture', agent: {} })).decision.kind, 'allow')
  assert.equal(applyReplacementsToText(result.text, patch(62)).changed, false)
})
