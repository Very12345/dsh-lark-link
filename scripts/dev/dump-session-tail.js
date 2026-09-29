// Full JSON of the last events of the newest session (multi-frame aware).
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
for (let k = 0; k < starts.length; k += 1) {
  const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
  try {
    text += zlib.zstdDecompressSync(buf.subarray(starts[k], end)).toString("utf8");
  } catch {}
}
const lines = text.split("\n").filter(Boolean);
const wanted = /"type":"(turn\/end|tool\/result|tool\/call|assistant\/attempt|step\/end|agent\/|session\/)/;
console.log("events:", lines.length);
for (const line of lines.slice(-14)) {
  const m = line.match(/"type":"([^"]+)"/);
  console.log("-----", m ? m[1] : "?", "len", line.length);
  console.log(line.slice(0, 700));
}
