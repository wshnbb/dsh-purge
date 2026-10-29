import assert from "node:assert/strict";
import test from "node:test";
import { rewritePromptAssembly } from "../lib/identity.js";
import { CAPABILITY_SECTION } from "../lib/capability-protocol.js";

// Harmless fixtures exercise mode selection and section ownership only.
const operator = "Use the user's preferred name and language. Report observed results accurately.";
const ops = "## 运行环境前提\nTest environment notes.\n## 指挥职责\nFixture coordinator duties.";
const presetSection = { name: "deployment:persona-prefix", text: ops };
const role = { name: "dshpg-redteam-role", text: "Fixture role instructions." };
const objective = { name: "dshpg-objective", text: "Fixture objective." };
const context = (preset) => ({ session: { header: { agentPreset: preset } } });
const run = (sections, ctx) => rewritePromptAssembly({
  sections, contexts: [{ name: "required", text: "Preserve runtime facts." }],
  tools: [{ name: "fixture_tool" }], variables: { model: "fixture" },
}, { fallbackInject: operator, dropMnemon: false, context: ctx });
const protocol = (result) => result.sections.find(s => s.name === CAPABILITY_SECTION)?.text || "";

test("an explicit ordinary preset overrides stale redteam sections", () => {
  for (const preset of ["standard", "liangshen", "custom-coding"]) {
    const result = run([presetSection, role, objective], context(preset));
    assert.ok(!protocol(result).includes("redteam lead"));
    assert.ok(!result.sections.some(s => [role.name, objective.name].includes(s.name)));
    assert.ok(!result.sections.some(s => s.text.includes("Fixture coordinator duties.")));
    assert.ok(result.sections.some(s => s.text.includes(operator)));
    assert.deepEqual(result.contexts, [{ name: "required", text: "Preserve runtime facts." }]);
    assert.deepEqual(result.tools, [{ name: "fixture_tool" }]);
  }
});

test("the mounted preset overrides an old redteam session header", () => {
  const result = run([presetSection, role], {
    agent: {
      session: { header: { agentPreset: "redteam" } },
      ctx: { get: () => ({ composedPreset: () => ({ id: "standard" }) }) },
    },
  });
  assert.ok(!protocol(result).includes("redteam lead"));
  assert.ok(!result.sections.some(s => s.name === role.name));
});

test("a selected ordinary preset overrides the creation-time header", () => {
  const result = run([presetSection], { session: {
    header: { agentPreset: "redteam" },
    events: [{ type: "agent-preset/selected", data: { agentPreset: "standard" } }],
  } });
  assert.ok(!protocol(result).includes("redteam lead"));
});

test("a child inherits the parent's explicit ordinary mode", () => {
  const parent = { header: { agentPreset: "standard" } };
  const result = run([presetSection, role], { agent: {
    session: { header: { agentPreset: "redteam", origin: "subagent", parentSession: "p" } },
    parent: { session: parent },
  } });
  assert.ok(!protocol(result).includes("redteam lead"));
  assert.ok(!result.sections.some(s => s.name === role.name));
});

test("known redteam mode and legacy persona fallback still retain their sections", () => {
  for (const ctx of [context("redteam"), undefined]) {
    const result = run([presetSection, role, objective], ctx);
    assert.ok(protocol(result).includes("redteam lead"));
    assert.equal(result.sections.find(s => s.name === role.name)?.text, role.text);
    assert.equal(result.sections.find(s => s.name === objective.name)?.text, objective.text);
    assert.ok(result.sections.some(s => s.text.includes("Fixture coordinator duties.")));
  }
});

test("quoted headings in workspace and user rules neither choose a mode nor get deleted", () => {
  const workspace = { name: "workspace-instructions", text: `Project documentation example:\n${ops}\nKeep the entire example.` };
  const rules = { name: "dsh-purge:rules", text: `User-authored notes:\n${ops}\nKeep these notes.` };
  for (const ctx of [undefined, context("standard"), context("redteam")]) {
    const result = run([workspace, rules], ctx);
    assert.equal(result.sections.find(s => s.name === workspace.name)?.text, workspace.text);
    assert.equal(result.sections.find(s => s.name === rules.name)?.text, rules.text);
    assert.equal(protocol(result).includes("redteam lead"), ctx?.session.header.agentPreset === "redteam");
  }
});

test("a generic environment heading alone is not a redteam persona", () => {
  const persona = { name: "deployment:persona-prefix", text: "## 运行环境前提\nUse Windows PowerShell for this coding project." };
  const result = run([persona], undefined);
  assert.ok(!protocol(result).includes("redteam lead"));
  assert.ok(result.sections.some(s => s.text.includes(persona.text)));
});

test("reassembling after a mode switch removes stale roles without mutating input", () => {
  const first = run([presetSection, role, objective], context("redteam"));
  const before = structuredClone(first);
  const options = { fallbackInject: operator, dropMnemon: false, context: context("standard") };
  const second = rewritePromptAssembly(first, options);
  assert.deepEqual(first, before);
  assert.ok(!protocol(second).includes("redteam lead"));
  assert.ok(!second.sections.some(s => [role.name, objective.name].includes(s.name)));
  assert.equal(second.sections.filter(s => s.name === CAPABILITY_SECTION).length, 1);
  assert.equal(second.sections.map(s => s.text).join("\n").split(operator).length - 1, 1);
  assert.deepEqual(rewritePromptAssembly(second, options), second);
});
