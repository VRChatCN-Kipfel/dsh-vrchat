/** Show the name-sort vs mtime-sort difference on the real generation list. */
const fs = require("node:fs");
const { liveRoot, newestGeneration } = require("./lib-generation.cjs");

const all = fs
  .readdirSync(liveRoot(), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("dsh-vrchat-kb+"))
  .map((entry) => entry.name);

console.log("已安装的代（按时间倒序）:");
for (const name of all
  .map((name) => ({ name, mtime: fs.statSync(`${liveRoot()}/${name}`).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)) {
  console.log(`  ${new Date(name.mtime).toISOString().slice(11, 19)}  ${name.name}`);
}
console.log("");
console.log(`按名字取最后一个: ${all.slice().sort().at(-1)}   ← 错误`);
console.log(`按时间取最新:     ${newestGeneration("dsh-vrchat-kb+")}   ← 正确`);
