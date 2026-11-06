import path from "node:path";

// These probes explain drift without changing targets or writing host files.
const MIGRATIONS = new Map([
  [32, ["dsh-harness-dev-context", "lib/index.js", "Web GUI"]],
  [53, ["dsh-harness-dev-context", "lib/index.js", "Do not start a replacement server"]],
  [54, ["dsh-deliverable-file-references", "lib/index.js", "Do not call present just to list"]],
  [60, ["dsh-tool-executor-ptc", "lib/index.js", "Wider sandbox mode for this complete program"]],
  [62, ["dsh-tools", "lib/pipeline.js", "no approval channel is available"]],
]);

export function patchDisposition(patch, text, { aiBase = "", readText = () => "" } = {}) {
  if (patch.id === 77 && !text.includes("function isRewindMarker(")) {
    return { status: "unmatched", code: "missing-prerequisite", reason: "缺少回退标记解析器，不能只插入其调用。" };
  }
  if (patch.id === 80 && !/\[dsh-purge\] minimal (?:fs|web) tool parity/.test(text)) {
    return { status: "skipped", code: "cleanup-empty", reason: "没有旧版追加的工具块，无需清理。" };
  }
  if (patch.id === 88 && /renderPrompt\(assembly\)/.test(text) && !text.includes("dshPurgeHung")) {
    return { status: "skipped", code: "cleanup-empty", reason: "没有旧版 renderPrompt 挂针，无需清理。" };
  }
  if (patch.id === 40 && /refreshContext\(/.test(text) && text.includes("toolProviders") && text.includes("completeSection")) {
    return { status: "superseded", code: "native-finalization", reason: "新版宿主自行完成 complete、工具和必需上下文的组装；旧静态补丁停用，沿用公开 assemble 事件。" };
  }
  if ([74, 87].includes(patch.id) && text.includes("this.loopCtx.tools.resolve(") && /this\.loopCtx\.systemPrompt\.assemble\(\{/.test(text)) {
    return { status: "superseded", code: "public-assembly-event", reason: "新版走公开 system-prompt/assemble 事件；不再插入两层旧版首次组装钩子。" };
  }
  if (patch.id === 82 && aiBase) {
    const filename = path.join(aiBase, "dsh-desktop-host", "lib", "index.js");
    let source = "";
    try { source = readText(filename); } catch { /* Unknown layouts must remain unmatched. */ }
    if (/runProfile\(\{[\s\S]{0,400}?profile:\s*["']desktop["']/.test(source)) {
      return { status: "superseded", code: "explicit-profile", reason: "新版桌面宿主显式传入 desktop profile，不再依赖旧环境变量兜底。", evidence: filename };
    }
  }
  return null;
}

export function unmatchedDiagnostic(patch, text, { aiBase = "", readText = () => "" } = {}) {
  const markers = (patch.markers || (patch.marker ? [patch.marker] : [])).filter(Boolean);
  const present = markers.filter(marker => text.replace(/\r\n/g, "\n").includes(String(marker).replace(/\r\n/g, "\n")));
  if (!patch.markersAny && present.length > 0 && present.length < markers.length) {
    return { status: "partial", code: "partial-markers", reason: `仅发现 ${present.length}/${markers.length} 个完成标记；其余修改未确认。` };
  }
  const migration = MIGRATIONS.get(patch.id);
  if (migration && aiBase) {
    const filename = path.join(aiBase, migration[0], migration[1]);
    let source = "";
    try { source = readText(filename); } catch { /* A failed probe is not evidence of relocation. */ }
    if (source.includes(migration[2])) {
      return { status: "unmatched", code: "target-moved", reason: `相关代码已迁移到 ${migration[0]}/${migration[1]}；旧规则未覆盖该位置。`, evidence: filename };
    }
  }
  return { status: "unmatched", code: "pattern-drift", reason: "目标文件存在，但旧代码与完成标记均未匹配；需要检查版本适配。" };
}

export function summarizeDiagnostics(entries, fallback = "missing_file", { strictFiles = false } = {}) {
  const statuses = entries.map(entry => entry.status);
  const readError = entries.find(entry => entry.code === "read-error");
  const order = strictFiles
    ? ["partial", "unmatched", "pending", "applied", "superseded", "skipped"]
    : ["partial", "pending", "applied", "unmatched", "superseded", "skipped"];
  const status = readError ? "unmatched" : order.find(value => statuses.includes(value)) || fallback;
  const relevant = entries.filter(entry => entry.status === status);
  const reasons = [...new Set(relevant.map(entry => entry.reason).filter(Boolean))];
  return { status, reason: reasons.join(" "), files: entries };
}
