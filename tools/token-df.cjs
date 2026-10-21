/** Word-boundary document frequency for ASCII tokens, and substring df for CJK. */
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.join(__dirname, "..", "data");
const index = JSON.parse(fs.readFileSync(path.join(dataDir, "index.json"), "utf8"));
const pages = JSON.parse(fs.readFileSync(path.join(dataDir, "pages.json"), "utf8"));

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const haystacks = index.map((entry) =>
  `${entry.title}\n${entry.tags.join(" ")}\n${pages[entry.path] ?? ""}`.toLowerCase(),
);

for (const token of process.argv.slice(2)) {
  let df = 0;
  if (/^[a-z0-9_]+$/.test(token)) {
    const re = new RegExp(`\\b${escape(token)}\\b`);
    for (const haystack of haystacks) if (re.test(haystack)) df++;
  } else {
    for (const haystack of haystacks) if (haystack.includes(token)) df++;
  }
  console.log(`${token.padEnd(10)} df=${String(df).padStart(3)}  ${((df / index.length) * 100).toFixed(1)}%`);
}
