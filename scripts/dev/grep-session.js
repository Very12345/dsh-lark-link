// Decode a (multi-frame) session log and print lines matching keywords.
// usage: node grep-session.js <session-file> <kw1> <kw2> ...
const zlib = require("node:zlib");
const fs = require("node:fs");

const file = process.argv[2];
const kws = process.argv.slice(3).map((k) => k.toLowerCase());
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
console.log(`# ${file.split("/").slice(-2)[0]} events=${lines.length} kws=${kws.join(",")}`);
let hits = 0;
for (const line of lines) {
  const low = line.toLowerCase();
  if (kws.some((k) => low.includes(k))) {
    hits += 1;
    const m = line.match(/"type":"([^"]+)"/);
    const seq = line.match(/"seq":(\d+)/);
    console.log(`--- [${seq ? seq[1] : "?"}] ${m ? m[1] : "?"}`);
    console.log(line.slice(0, 1100));
  }
}
console.log(`# hits=${hits}`);
