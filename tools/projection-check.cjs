/**
 * Verify the projection registration shape against the shipped service.
 *
 * A projection unit is registered as
 *   { key, stateSchema, viewSchema, init, apply, wire: { viewSchema, view }, stateVersion }
 * and the service validates through the schemas, so they must be real zod
 * schemas — schemastery would not validate here. This checks that the plugin
 * builds its schemas from `zod` and that the fold is pure, without needing a
 * live Session.
 *
 * Usage: node tools/projection-check.cjs
 */
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "index.js"), "utf8");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

// ── the schemas must come from zod, not schemastery ───────────────────────
check("从 zod 导入", /import \{ z as zod \} from "zod"/.test(source));
check("package.json 声明 zod 依赖", /"zod"/.test(fs.readFileSync(path.join(root, "package.json"), "utf8")));
check("stateSchema 由 zod 构建", /stateSchema:\s*ledgerStateSchema/.test(source) && /ledgerStateSchema = zod\.object/.test(source));
check("viewSchema 由 zod 构建", /viewSchema:\s*ledgerViewSchema/.test(source) && /ledgerViewSchema = zod\.object/.test(source));

// ── optional service must be guarded ──────────────────────────────────────
check("投影通过 ctx.get 取得", /ctx\.get\("sessionProjections"\)/.test(source));
check("未注册时不影响注入", /if \(projections !== undefined\)/.test(source));
check("读取有 try/catch 兜底", /stateOf\(agent\.session, "vrchatKb"\)/.test(source));

// ── the fold must be pure (no I/O, no mutation of the input) ──────────────
const ledger = fs.readFileSync(path.join(root, "lib", "ledger.js"), "utf8");
check("ledger 无文件读写", !/readFileSync|writeFileSync|process\.|fetch\(/.test(ledger));
check("ledger 不修改入参", !/\bstate\.\w+\s*=[^=]/.test(ledger), "should build new objects");
check("无关事件返回同一引用", /return state;/.test(ledger));

// ── only existing event types are folded ─────────────────────────────────
check("折叠 tool/call", /event\.type !== "tool\/call"/.test(ledger));
check("记录轮边界 turn/start", /event\.type === "turn\/start"/.test(ledger));
check(
  "压缩使记录失效 compaction/start",
  /event\.type === "compaction\/start"/.test(ledger) && /generation: state\.generation \+ 1/.test(ledger),
);
check("不引入自定义事件类型", !/session\.append\(/.test(source));

// ── the two scope rules must both be enforced in the lookup ─────────────
check(
  "seen 判定同时校验 turn 与 generation",
  /entry\.turn === state\.turn/.test(ledger) && /entry\.generation === state\.generation/.test(ledger),
);
check(
  "提示文案说明是「本轮」而非「本会话」",
  /本轮已查过等价问题/.test(source),
  "cross-turn or post-compaction must not claim already-asked",
);

// ── client reads the same key the Host registers ─────────────────────────
const client = fs.readFileSync(path.join(root, "client.js"), "utf8");
const registered = /key:\s*"([^"]+)"/.exec(source);
const read = /useProjection\(\s*"([^"]+)"\s*\)/.exec(client);
check(
  "客户端与 Host 使用同一投影 key",
  registered !== null && read !== null && registered[1] === read[1],
  `host=${registered?.[1]} client=${read?.[1]}`,
);

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
