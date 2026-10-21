/** Measure a content page's cost with the CJK-aware estimate. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const CJK = /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
const root = process.argv[2] ?? ".";

for (const rel of ["content-src/persona-prefix.md", "content-src/t0-core.md", "data/t1-world.txt"]) {
  let text;
  try {
    text = readFileSync(join(root, rel), "utf8");
  } catch {
    continue;
  }
  if (rel.endsWith(".md") && text.startsWith("---")) {
    text = text.replace(/^---[\s\S]*?---\n/, "").trim();
  }
  let cjk = 0;
  let ascii = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else ascii++;
  }
  const low = Math.round(cjk / 1.6 + ascii / 4);
  const high = Math.round(cjk / 1 + ascii / 3);
  console.log(
    `${rel.padEnd(30)} chars=${String(text.length).padStart(5)} lines=${String(text.split("\n").length).padStart(4)} tok=${low}-${high}`,
  );
}
