import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { rewritePromptAssembly } from "../lib/identity.js";
import { ALL_PATCHES, applyReplacementsToText, atomicCopyFileSync } from "../lib/core.js";
import { hostFs } from "../lib/extract-asar.js";
import { repairOfficialCliAfterUnpack } from "../lib/desktop.js";

const options = { capabilityProtocol: false, dropMnemon: false };

test("0.2.1 assemblies render without an unregistered cwd variable", () => {
  const original = {
    variables: { provider: "test", model: "test" },
    sections: [
      { name: "deployment:persona-suffix", text: "Your working directory is {{cwd}}." },
      { name: "workspace", text: "Directory: {{ cwd }}; model: {{model}}." },
      { name: "literal", text: "Example: {{cwd}}", interpolate: false },
    ],
    contexts: [{ name: "workspace-context", text: "{{cwd}}" }],
    tools: [],
  };
  const before = structuredClone(original);
  const rewritten = rewritePromptAssembly(original, "", options);
  assert.equal(rewritten.sections.find(s => s.name === "deployment:persona-suffix").text,
    "Your working directory is the current workspace.");
  assert.equal(rewritten.sections.find(s => s.name === "workspace").text,
    "Directory: the current workspace; model: {{model}}.");
  assert.equal(rewritten.sections.find(s => s.name === "literal").text, "Example: {{cwd}}");
  assert.equal(rewritten.contexts[0].text, "the current workspace");
  assert.deepEqual(original, before);
  assert.deepEqual(rewritePromptAssembly(rewritten, "", options), rewritten);
});

test("older hosts with cwd preserve interpolation and the directory value", () => {
  const rewritten = rewritePromptAssembly({ sections: [], contexts: [], tools: [],
    variables: { cwd: "D:/example" } }, "", options);
  assert.equal(rewritten.sections.find(s => s.name === "deployment:persona-suffix").text,
    "Your working directory is {{cwd}}.");
  assert.equal(rewritten.variables.cwd, "D:/example");
});

test("missing or unresolved cwd uses the static fallback", () => {
  for (const variables of [undefined, {}, { cwd: undefined }]) {
    const rewritten = rewritePromptAssembly({ sections: [], variables }, "", options);
    assert.ok(rewritten.sections.every(s => !s.text.includes("{{cwd}}")));
  }
});

const host021Tail = `
const transformed = await this.ctx.waterfall(scopeTarget(this, scope), "system-prompt/assemble", assembly, context, () => Promise.resolve(assembly));
if (completeSection === void 0 && !runtimeContextSuppressed) return transformed;
const requiredContexts = new Set([...contextByName.values()].filter((entry) => entry.required === true).map((entry) => entry.name));
return {
  ...transformed,
  sections: completeSection === void 0 ? transformed.sections : [completeSection],
  contexts: runtimeContextSuppressed ? transformed.contexts.filter((entry) => requiredContexts.has(entry.name)) : transformed.contexts
};`;

test("patch 40 matches 0.2.1 and preserves required-context filtering", async () => {
  const patch = ALL_PATCHES.find(p => p.id === 40);
  const applied = applyReplacementsToText(host021Tail, patch);
  assert.notEqual(applied.text, host021Tail);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const assemble = new AsyncFunction("assembly", "completeSection", "runtimeContextSuppressed",
    "contextByName", "scopeTarget", "scope", "context", applied.text);
  const assembly = {
    sections: [{ name: "deployment:persona-prefix", text: "workspace instructions" }],
    contexts: [{ name: "required", text: "required fact" }, { name: "optional", text: "optional fact" }],
    variables: { model: "test" }, tools: [],
  };
  const layer = { ctx: { waterfall: async () => assembly } };
  const registrations = new Map([
    ["required", { name: "required", required: true }],
    ["optional", { name: "optional", required: false }],
  ]);
  const suppressed = await assemble.call(layer, assembly, undefined, true, registrations, () => null);
  assert.deepEqual(suppressed.contexts, [assembly.contexts[0]]);
  const complete = await assemble.call(layer, assembly, assembly.sections[0], false, registrations, () => null);
  assert.deepEqual(complete.contexts, assembly.contexts);
  assert.equal(complete.sections[0].text, "workspace instructions");
  assert.equal(applyReplacementsToText(applied.text, patch).text, applied.text);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-purge-compat-"));
  t.after(() => {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep + "dsh-purge-compat-"));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("descriptor writes and atomic backup finish without leaks or partial files", t => {
  const root = fixture(t);
  const src = path.join(root, "source.txt");
  const dst = path.join(root, "backup.txt");
  const fd = hostFs.openSync(src, "w+");
  try {
    hostFs.writeSync(fd, Buffer.from("original bytes"));
    hostFs.fsyncSync(fd);
    assert.equal(hostFs.fstatSync(fd).size, 14);
  } finally {
    hostFs.closeSync(fd);
  }
  atomicCopyFileSync(src, dst);
  fs.writeFileSync(src, "replacement");
  assert.equal(fs.readFileSync(dst, "utf8"), "original bytes");
  assert.throws(() => atomicCopyFileSync(path.join(root, "missing"), dst));
  assert.equal(fs.readFileSync(dst, "utf8"), "original bytes");
  assert.ok(fs.readdirSync(root).every(name => !name.endsWith("copytmp")));
});

test("desktop CLI repair creates an exact backup before changing the launcher", t => {
  const root = fixture(t);
  const exe = path.join(root, "DeepSeek Harness.exe");
  const resources = path.join(root, "resources");
  const bin = path.join(resources, "runtime", "cli", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(path.join(resources, "app", "runtime"), { recursive: true });
  fs.writeFileSync(exe, "");
  const shim = path.join(bin, "dsh.cmd");
  const original = '@echo off\nset "ELECTRON_RUN_AS_NODE=1"\nset "entry=%~dp0..\\..\\..\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js"\n"%~dp0..\\..\\..\\..\\DeepSeek Harness.exe" --expose-internals "%entry%" %*\n';
  fs.writeFileSync(shim, original);
  const report = repairOfficialCliAfterUnpack(exe);
  const row = report.shims.find(entry => entry.path === shim);
  assert.equal(row?.status, "patched");
  assert.equal(fs.readFileSync(`${shim}.dsh-purge.bak`, "utf8"), original);
  assert.notEqual(fs.readFileSync(shim, "utf8"), original);
});
