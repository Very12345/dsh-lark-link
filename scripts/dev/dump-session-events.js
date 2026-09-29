// Multi-frame zstd: the session log appends one frame per flush, and Node's
// zstd API decodes only the FIRST frame — split on the frame magic instead.
const zlib = require("node:zlib");
const fs = require("node:fs");

const buf = fs.readFileSync(process.argv[2]);
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
let frames = 0;
for (let k = 0; k < starts.length; k += 1) {
  const start = starts[k];
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try {
    text += zlib.zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
    frames += 1;
  } catch {
    if (k + 2 <= starts.length - 1) {
      try {
        text += zlib.zstdDecompressSync(buf.subarray(start, starts[k + 2])).toString("utf8");
        frames += 1;
        k += 1;
      } catch {}
    }
  }
}
const lines = text.split("\n").filter(Boolean);
console.log("frames=", frames, "events=", lines.length);

const interesting = [];
for (const line of lines) {
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    continue;
  }
  const t = e.type || "";
  const d = e.data || {};
  if (t === "turn/end") {
    interesting.push(`[${e.seq}] turn/end turn=${d.turn} ${JSON.stringify(d.reason).slice(0, 500)}`);
  } else if (/tool/i.test(t)) {
    const name = d.name ?? d.toolName ?? d.call?.name ?? d.tool?.name ?? "?";
    const code = d.code ?? d.result?.code ?? d.error?.code ?? "";
    const msg = d.message ?? d.result?.message ?? d.error?.message ?? "";
    const args = d.args ?? d.call?.args ?? d.parameters ?? d.input ?? "";
    interesting.push(`[${e.seq}] ${t} ${name} code=${code} args=${JSON.stringify(args).slice(0, 200)} msg=${String(msg).slice(0, 260)}`);
  } else if (t === "assistant/attempt") {
    const stream = Array.isArray(d.stream) ? d.stream : [];
    const fin = stream.find((x) => x.chunk?.type === "finish");
    if (fin) interesting.push(`[${e.seq}] attempt ${JSON.stringify(fin.chunk).slice(0, 500)}`);
  } else if (t === "step/end") {
    const s2 = JSON.stringify(d);
    if (/error|fail|INVALID/i.test(s2)) interesting.push(`[${e.seq}] step/end ${s2.slice(0, 320)}`);
  }
}
console.log(interesting.slice(-45).join("\n"));
