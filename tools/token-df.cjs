/**
 * Document frequency for a token: how many pages contain it, and what fraction that
 * is. Used to judge whether a word is discriminating enough to route on.
 *
 * This used to read `data/pages.json`, which `build-knowledge.mjs` deliberately
 * deletes: page bodies stopped being a shipped artifact once they were read lazily
 * from the corpus submodule. So the tool crashed with ENOENT on every run, and the
 * README advertised it as a working command.
 *
 * Body text now comes from the corpus directly, through the same store the plugin
 * uses — which is also the correct source: it is what the ranking actually reads.
 *
 * Usage: node tools/token-df.cjs rust 同步 quest
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "search.js")).href);
  const root = path.join(__dirname, "..");
  const corpusRoot = mod.findCorpusRoot(root);
  if (corpusRoot === null) {
    console.error("找不到语料根：先确保 VRChat-Agent-Creator-Library/ 已 clone（或 npm install 跑过 prepare）。");
    process.exit(2);
  }
  const store = mod.createStore(path.join(root, "data"), corpusRoot);

  const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const haystacks = store.index.map((entry) => {
    const body = store.bodyOf(entry.path) ?? "";
    return `${entry.title}\n${entry.tags.join(" ")}\n${body}`.toLowerCase();
  });

  for (const token of process.argv.slice(2)) {
    let df = 0;
    if (/^[a-z0-9_]+$/i.test(token)) {
      // Word boundary for ASCII: `rust` must not count a page that only says "Trust".
      const re = new RegExp(`\\b${escape(token.toLowerCase())}\\b`);
      for (const haystack of haystacks) if (re.test(haystack)) df++;
    } else {
      for (const haystack of haystacks) if (haystack.includes(token.toLowerCase())) df++;
    }
    const pct = ((df / Math.max(store.index.length, 1)) * 100).toFixed(1);
    console.log(`${token.padEnd(10)} df=${String(df).padStart(3)}  ${pct}%`);
  }
}

main().catch((error) => {
  console.error(error?.message ?? error);
  process.exit(1);
});
