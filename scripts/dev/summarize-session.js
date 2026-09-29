// Whole-conversation summary: turns, end reasons, tool failures, timings.
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
const buf = fs.readFileSync(file);
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const starts = [];
let p = 0;
for (;;) {
  const i = buf.indexOf(MAGIC, p);
  if (i < 0) break;
  starts.push(i);
  p = i + 4;
}
let text = "";
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try {
    text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
  } catch {}
}
const lines = text.split("\n").filter(Boolean);
const t0 = (ts) => new Date(ts).toISOString().slice(11, 19);
let steps = 0;
const toolCalls = new Map();
const errors = [];
const turns = [];
let firstAt = null;
let lastAt = null;
for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const d = e.data || {};
  if (typeof e.time === "number") {
    if (!firstAt) firstAt = e.time;
    lastAt = e.time;
  }
  if (e.type === "step/start") steps += 1;
  if (e.type === "tool/ptc-dispatch-start") toolCalls.set(d.name, (toolCalls.get(d.name) || 0) + 1);
  if (e.type === "tool/ptc-dispatch" && d.isError) {
    const txt = JSON.stringify(d.content || "").slice(0, 140);
    errors.push(`[t${d.turn ?? "?"}] ${d.name}: ${txt}`);
  }
  if (e.type === "assistant/attempt") {
    const fin = (d.stream || []).find((x) => x.chunk?.type === "finish");
    if (fin && fin.chunk?.reason?.kind === "error") {
      errors.push(`[t${d.turn ?? "?"}] finish: ${fin.chunk.reason.failure?.message}`);
    }
  }
  if (e.type === "turn/end") {
    turns.push({ turn: d.turn, kind: d.reason?.kind, at: e.time, err: d.reason?.error?.message });
  }
}
console.log(`events=${lines.length} steps=${steps} span=${t0(firstAt)}..${t0(lastAt)} turns=${turns.length}`);
console.log("== tool calls ==");
for (const [name, n] of [...toolCalls].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${name}`);
console.log("== turns ==");
for (const t of turns) {
  console.log(`  turn ${t.turn} @${t0(t.at)} ${t.kind}${t.err ? ` — ${String(t.err).slice(0, 110)}` : ""}`);
}
console.log(`== errors (${errors.length}) ==`);
for (const x of errors.slice(0, 25)) console.log("  " + String(x).slice(0, 200));
