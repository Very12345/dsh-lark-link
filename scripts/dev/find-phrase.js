// Print every occurrence of a phrase (with a text window) across session logs.
// usage: node find-phrase.js <session-file> [kw ...]
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
const kws = process.argv.slice(3);
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
let found = 0;
for (const line of lines) {
  for (const k of kws) {
    let idx = line.indexOf(k);
    while (idx >= 0) {
      found += 1;
      const seq = line.match(/"seq":(\d+)/);
      const type = line.match(/"type":"([^"]+)"/);
      const from = Math.max(0, idx - 200);
      console.log(`--- [${seq ? seq[1] : "?"}] ${type ? type[1] : "?"} :: ...${line.slice(from, idx + 420)}...`);
      idx = line.indexOf(k, idx + k.length);
      if (found > 12) break;
    }
    if (found > 12) break;
  }
  if (found > 12) break;
}
console.log(`# ${file.split("/").slice(-2)[0]} events=${lines.length} found=${found}`);
