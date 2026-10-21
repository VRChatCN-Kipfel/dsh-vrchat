/**
 * VRChat KB — proactive injection + a purpose-built query tool.
 *
 * Division of labour, which is the point of this plugin:
 *   - INJECTION carries only "what exists": red lines and coverage. Never locations.
 *   - The TOOL owns "where is it". The agent never has to read index.md, guess a
 *     path, or grep the submodule to find an answer.
 *
 * Two instances may be mounted (global `tier: lite`, preset `tier: full`). They
 * register the SAME section name, so the preset's scoped section shadows the
 * global one — the shadowing is the mode switch, no coordination code needed.
 * They share this module file, hence the single module-level store.
 *
 * Retrieval lives in `lib/search.js` (pure, Harness-free) so `tools/selftest.cjs`
 * and `tools/debug-query.cjs` exercise exactly the code the plugin runs.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createStore, answer } from "./lib/search.js";
import { lintSource, rankFindings, ruleInventory } from "./lib/lint.js";
import { readPage, grepPages } from "./lib/docs.js";
import {
  initLedger,
  applyLedger,
  ledgerView,
  findPriorQuery,
} from "./lib/ledger.js";

const name = "vrchat-kb";

/**
 * Cordis `Inject` is `(keyof M)[] | { [K]: config }` — a plain list of required
 * services. Optional services are NOT declared here: `ctx.get(name)` returns
 * undefined when absent, which is exactly the fallback path.
 */
const inject = ["systemPrompt", "tools"];

const Config = z.object({
  /** `lite` = global default (red lines only); `full` = preset mode (red lines + digest). */
  tier: z.string().default("lite"),
  /** Character budget for the evidence returned by one query. */
  charBudget: z.number().default(3200),
  /** Maximum pages returned by one query. */
  maxPages: z.number().default(4),
});

const dataDir = join(dirname(fileURLToPath(import.meta.url)), "data");

/**
 * Projection schemas.
 *
 * `stateSchema` and `viewSchema` must be zod schemas (the projection service
 * validates through them), hence the separate zod import beside schemastery.
 */
const ledgerEntrySchema = zod.object({
  normalized: zod.string(),
  query: zod.string(),
  turn: zod.number(),
  generation: zod.number(),
  at: zod.number(),
});

const ledgerStateSchema = zod.object({
  version: zod.number(),
  blockTokens: zod.number(),
  turn: zod.number(),
  generation: zod.number(),
  queries: zod.array(ledgerEntrySchema),
  digestCalls: zod.number(),
  grepCalls: zod.number(),
  readCalls: zod.number(),
  scanCalls: zod.number(),
});

const ledgerViewSchema = zod.object({
  blockTokens: zod.number(),
  turn: zod.number(),
  digestCalls: zod.number(),
  grepCalls: zod.number(),
  readCalls: zod.number(),
  scanCalls: zod.number(),
  lastQuery: zod.string().nullable(),
});

/**
 * Verify the build artifacts exist before touching them.
 *
 * `data/` is a build product (`node tools/build-knowledge.mjs`), not tracked in
 * git. A missing artifact would otherwise surface as a bare ENOENT from
 * `apply()` — and a throw in `apply()` fails Harness STARTUP, because
 * dsh-app-boot treats every inactive entry as fatal at boot. Turning that into
 * one explicit, actionable message means a forgotten build step reads as an
 * instruction instead of a crash.
 */
function assertDataPresent() {
  const required = [
    "t0-core.txt",
    "always-load.txt",
    "domain-map.txt",
    "keyword-routes.json",
    "index.json",
    "pages.json",
    "manifest.json",
  ];
  const missing = required.filter((file) => !existsSync(join(dataDir, file)));
  if (missing.length > 0) {
    throw new Error(
      `dsh-vrchat-kb: data/ 不完整，缺少 ${missing.join(", ")}。` +
        `data/ 是构建产物，请先运行：node tools/build-knowledge.mjs`,
    );
  }
}

/** Shared by every mounted instance: they import this same file. */
let store = null;
let manifest = null;

function ensureStore() {
  if (store === null) store = createStore(dataDir);
  return store;
}

/**
 * Build metadata — read once so the prompt can state provenance from the build
 * rather than from hardcoded text.
 */
function ensureManifest() {
  if (manifest === null) {
    manifest = JSON.parse(readFileSync(join(dataDir, "manifest.json"), "utf8"));
  }
  return manifest;
}

/**
 * Register this instance's injected section and the query tool.
 * @param ctx - agent-scoped services.
 * @param config - which tier this instance stands for.
 */
function apply(ctx, config) {
  assertDataPresent();
  const data = ensureStore();
  const meta = ensureManifest();
  const tier = typeof config?.tier === "string" ? config.tier : "lite";
  const charBudget = Number.isSafeInteger(config?.charBudget) ? config.charBudget : 3200;
  const maxPages = Number.isSafeInteger(config?.maxPages) ? config.maxPages : 4;

  const blockKey = tier === "full" ? "always-load" : "t0-core";
  const block = meta.blocks?.[blockKey];
  // Provenance comes from the build manifest, never hardcoded in the .md.
  // Note: `{{variable}}` would be the "proper" channel, but the prompt
  // interpreter THROWS on an unknown variable or one with no value for an
  // assembly — a build-static fact is safer as plain substituted text.
  const provenance = [
    `库 v${meta.libraryVersion ?? "?"} / 上游 ${meta.pageCount ?? "?"} 页 / 构建 ${String(meta.builtAt ?? "").slice(0, 10)}`,
    block === undefined ? "" : `本块 ${block.tokensLow}–${block.tokensHigh} tok`,
  ]
    .filter((line) => line.length > 0)
    .join(" · ");

  // Preset mode REPLACES the global section (same name, scoped shadow), so it
  // must carry the red lines itself rather than inheriting them.
  const baseText = tier === "full" ? `${data.t0}\n\n---\n\n${data.alwaysLoad}` : data.t0;
  const sectionText = `${baseText}\n\n> ${provenance}`;

  ctx.systemPrompt.section({
    name: "vrchat-kb",
    order: 640,
    text: sectionText,
  });

  // ── Session ledger projection ─────────────────────────────────────────────
  // One unit serves the Chat row AND `seen` de-duplication. It is a pure fold
  // over committed events, so it survives resume/fork and costs nothing when
  // the event is irrelevant (same reference → no downstream recompute).
  //
  // Registered through ctx.get because `sessionProjections` is optional: the
  // plugin still injects without it, it just cannot remember queries.
  const projections = ctx.get("sessionProjections");
  if (projections !== undefined) {
    ctx.effect(() =>
      projections.register({
        key: "vrchatKb",
        stateSchema: ledgerStateSchema,
        viewSchema: ledgerViewSchema,
        init: () => initLedger(block?.tokensHigh ?? 0),
        apply: (state, event) => applyLedger(state, event),
        wire: {
          viewSchema: ledgerViewSchema,
          view: (state) => ledgerView(state),
        },
        stateVersion: 1,
      }),
    );
  }

  /** Read the ledger for one session, or undefined when unavailable. */
  const readLedger = (agent) => {
    if (projections === undefined || agent?.session === undefined) return undefined;
    try {
      return projections.stateOf(agent.session, "vrchatKb");
    } catch {
      return undefined;
    }
  };

  ctx.tools.register(
    defineTool({
      name: "vrchat_kb",
      description:
        "查询本地 VRChat 创作知识库（414 页：Udon/UdonSharp、网络同步、Persistence、Avatar/PhysBone/Shader、Udon API、Quest 平台、设计模式、工程红线）。" +
        "在以下情况调用：要写 UdonSharp 代码、修改或优化 Avatar、配置 Shader、处理同步与持久化、判断某 API 在 Quest 上能否用、不确定某个 VRChat 组件/工具的用法。" +
        "返回的是合并后的完整约束与原文摘录（不是文件路径列表），所以一次调用即够——不要针对同一问题反复查询。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "自然语言或关键词，例如「Udon 同步变量非 Owner 写入」「physbone 性能上限」「poiyomi quest 变体」。",
        },
        limit: {
          type: "integer",
          description: `最多返回多少页（默认 ${maxPages}）。`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            hit: { type: "boolean", required: true },
            pageCount: { type: "integer", required: true },
            routes: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const query = typeof args?.query === "string" ? args.query.trim() : "";
        if (query.length === 0) throw new Error("vrchat_kb requires a non-empty query");
        const limit =
          Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 12) : maxPages;

        // `seen`: only meaningful within the SAME turn and the SAME compaction
        // generation — `findPriorQuery` enforces both. Across turns the reply is
        // noise; after compaction the earlier digest was replaced out of the
        // visible conversation, so claiming "already asked" would hand the model
        // a claim it cannot look up. In either case, answer fresh.
        const ledger = readLedger(exec.agent);
        const prior = findPriorQuery(ledger, query);
        if (prior !== undefined) {
          const result = answer(data, query, { limit, charBudget });
          return {
            text:
              `本轮已查过等价问题：「${prior.query}」，结果就在上文，不必重复调用；换关键词才能得到不同角度。\n` +
              "下面是同一查询的内容，以备对照：\n\n" +
              result.text,
            hit: result.hit,
            pageCount: result.pageCount,
            routes: result.routes,
          };
        }

        const result = answer(data, query, { limit, charBudget });
        return {
          text: result.text,
          hit: result.hit,
          pageCount: result.pageCount,
          routes: result.routes,
        };
      },
    }),
  );

  // ── vrchat_kb_grep / vrchat_kb_read — library-scoped search and read ──────
  // Mirrors the official `grep` / `read` conventions on purpose: same parameter
  // names, same output shape, so the habit transfers with no learning cost.
  // The only thing owned here is path translation into the library.
  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_grep",
      description:
        "在 VRChat 知识库内搜索（414 页），返回按文件分组、带行号的命中行。" +
        "参数与行为对齐内置 grep：pattern / include，命中格式 `path` + `Line N: 内容`。" +
        "拿到行号后用 vrchat_kb_read 读取该处上下文。用于精确定位某个符号、规则编号或关键词。",
      parameters: {
        pattern: {
          type: "string",
          required: true,
          description: "正则表达式（不区分大小写），如 `PropertyToID`、`RULE-LL-\\d+`。",
        },
        include: {
          type: "string",
          description: '按文件名过滤的 glob，如 "*.md"、"{index,limits-and-quirks}.md"。',
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            ok: { type: "boolean", required: true },
            total: { type: "integer" },
            matches: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  path: { type: "string", required: true },
                  lineNumber: { type: "integer", required: true },
                  line: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const pattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
        if (pattern.length === 0) throw new Error("vrchat_kb_grep requires a non-empty pattern");
        const include = typeof args?.include === "string" ? args.include : undefined;
        const result = grepPages(data.pages, pattern, { include });
        return { text: result.text, ok: result.ok, total: result.total ?? 0, matches: result.matches ?? [] };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_read",
      description:
        "读取 VRChat 知识库中的单个页面，返回带行号的正文。" +
        "参数与输出对齐内置 read：file_path / offset / limit，行格式 `N: 内容`，末尾给出续读提示。" +
        "只接受库内路径（可用 vrchat_kb_grep 取得），不会读写工作区文件。",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "库内页面路径，如 entities/api/not-exposed.md（可省略 .md）。",
        },
        offset: {
          type: "number",
          description: "起始行（1-based），默认 1。",
        },
        limit: {
          type: "number",
          description: `最多返回行数，默认 200，上限 400。`,
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            ok: { type: "boolean", required: true },
            path: { type: "string" },
            offset: { type: "integer" },
            totalLines: { type: "integer" },
            lines: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  number: { type: "integer", required: true },
                  text: { type: "string", required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const filePath = typeof args?.file_path === "string" ? args.file_path.trim() : "";
        if (filePath.length === 0) throw new Error("vrchat_kb_read requires a non-empty file_path");
        const offset = Number.isInteger(args?.offset) ? args.offset : 1;
        const limit = Number.isInteger(args?.limit) ? args.limit : undefined;
        const result = readPage(data.pages, filePath, offset, limit);
        return {
          text: result.text,
          ok: result.ok,
          path: result.path,
          offset: result.offset,
          totalLines: result.totalLines,
          lines: result.lines,
        };
      },
    }),
  );

  // ── vrchat_kb_scan — a REPORT, never a guard ──────────────────────────────
  // Deliberately a tool the agent chooses to call, not a hook on write/edit.
  // Nothing blocks, mutates, or auto-fixes; the caller may read the findings and
  // knowingly ignore some to reach an effect.
  const scannable = new Set([".cs", ".shader"]);
  const MAX_FILES = 200;
  const MAX_BYTES = 256 * 1024;
  const MAX_DEPTH = 6;
  // Directories that never hold hand-written VRChat scripts.
  const PRUNE = new Set(["node_modules", ".git", "library", "temp", "obj", "logs", "build", "packages"]);

  /**
   * Expand caller paths into scannable files.
   *
   * A caller who wants to check "everything I just wrote" should not have to
   * enumerate files one by one, so a directory entry is walked recursively.
   * Traversal goes through `ctx.fs` only — the same sandboxed service the rest
   * of the tool uses — so it cannot reach outside what the session can read.
   *
   * @param fsService - the composed filesystem service.
   * @param entries - caller-supplied file or directory paths.
   * @param cwd - session working directory.
   * @param signal - cancellation.
   * @returns the resolved file list plus notes about what was skipped.
   */
  async function expandTargets(fsService, entries, cwd, signal) {
    /** Accepted files, each already carrying its resolved target from listDir. */
    const files = [];
    const skipped = [];
    const seen = new Set();

    const accept = (path, size) => {
      const extension = `.${path.split(".").pop().toLowerCase()}`;
      if (!scannable.has(extension)) {
        skipped.push(`${path}（不是可扫描类型，仅 .cs / .shader）`);
        return false;
      }
      if (seen.has(path)) return false;
      if (size !== undefined && size > MAX_BYTES) {
        skipped.push(`${path}（超过 ${MAX_BYTES / 1024} KB）`);
        return false;
      }
      seen.add(path);
      return true;
    };

    const walk = async (displayPath, depth, knownTarget) => {
      if (files.length >= MAX_FILES) return;
      if (depth > MAX_DEPTH) {
        skipped.push(`${displayPath}（目录层级超过 ${MAX_DEPTH}）`);
        return;
      }

      let target = knownTarget;
      let info;
      try {
        if (target === undefined) target = await fsService.resolve(displayPath, { cwd, signal });
        info = await fsService.stat(target, signal);
      } catch (error) {
        skipped.push(`${displayPath}（无法访问：${String(error?.message ?? error)}）`);
        return;
      }
      if (info === undefined) {
        skipped.push(`${displayPath}（不存在）`);
        return;
      }

      if (info.type === "file") {
        if (accept(displayPath, info.size)) files.push({ path: displayPath, target });
        return;
      }

      if (info.type !== "directory") {
        skipped.push(`${displayPath}（不是常规文件或目录）`);
        return;
      }

      let children;
      try {
        children = await fsService.listDir(target, signal);
      } catch (error) {
        skipped.push(`${displayPath}（无法列出：${String(error?.message ?? error)}）`);
        return;
      }

      const base = displayPath.replace(/\/+$/, "");
      for (const child of children) {
        const name = typeof child?.name === "string" ? child.name : "";
        if (name.length === 0) continue;
        if (PRUNE.has(name.toLowerCase())) continue;
        const childPath = `${base}/${name}`;

        if (child.type === "directory") {
          // listDir already handed back the resolved child target; reuse it.
          await walk(childPath, depth + 1, child.target);
        } else if (child.type === "file" && accept(childPath, child.size)) {
          if (files.length < MAX_FILES) files.push({ path: childPath, target: child.target });
        }
      }
    };

    for (const entry of entries) {
      if (files.length >= MAX_FILES) {
        skipped.push(`已达 ${MAX_FILES} 个文件上限，其余未展开`);
        break;
      }
      await walk(entry, 0, undefined);
    }

    return { files, skipped };
  }

  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_scan",
      description:
        "扫描产出的源文件，报告与 VRChat 硬约束冲突的地方（只报告，不阻断、不修改、不自动修复）。" +
        "适合在写完 UdonSharp / Shader 之后自检一遍。paths 可以是文件，也可以是目录（目录会递归扫其中的 .cs / .shader）。" +
        "每条结果都注明依据的约束与原因，你可以自行判断某些条目是否需要忽略（例如为达成效果刻意使用不推荐的写法）。" +
        "注意：只覆盖可机械判定的规则，报告干净不等于代码正确。",
      parameters: {
        paths: {
          type: "array",
          required: true,
          items: { type: "string" },
          description: "文件或目录路径（相对会话工作目录或绝对路径）。传目录会递归扫描其中的 .cs / .shader。",
        },
        minSeverity: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "只报告该级别及以上（默认 low，即全部）。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            ok: { type: "boolean", required: true },
            findings: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  file: { type: "string", required: true },
                  line: { type: "integer", required: true },
                  rule: { type: "string", required: true },
                  severity: { type: "string", required: true },
                  title: { type: "string", required: true },
                  because: { type: "string", required: true },
                  alternative: { type: "string" },
                  ref: { type: "string" },
                  evidence: { type: "string" },
                },
              },
            },
            scanned: { type: "array", items: { type: "string" } },
            skipped: { type: "array", items: { type: "string" } },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        const requested = Array.isArray(args?.paths) ? args.paths.filter((p) => typeof p === "string" && p.trim() !== "") : [];
        if (requested.length === 0) throw new Error("vrchat_kb_scan requires at least one path");
        const minSeverity = ["high", "medium", "low"].includes(args?.minSeverity) ? args.minSeverity : "low";

        const cwd = exec.agent?.session?.header?.cwd;
        const fsService = ctx.get("fs");
        if (fsService === undefined) throw new Error("vrchat_kb_scan needs the filesystem service");
        if (cwd === undefined) throw new Error("vrchat_kb_scan needs a session working directory");

        const expanded = await expandTargets(fsService, requested, cwd, exec.signal);
        const skipped = [...expanded.skipped];
        const scanned = [];
        let all = [];

        for (const file of expanded.files) {
          try {
            const text = await fsService.readText(file.target, exec.signal);
            if (text.length > MAX_BYTES) {
              skipped.push(`${file.path}（超过 ${MAX_BYTES / 1024} KB）`);
              continue;
            }
            scanned.push(file.path);
            all = all.concat(lintSource(file.path, text));
          } catch (error) {
            skipped.push(`${file.path}（读取失败：${String(error?.message ?? error)}）`);
          }
        }

        const findings = rankFindings(all, minSeverity);
        const lines = [];

        if (scanned.length === 0) {
          lines.push("没有可扫描的文件。");
        } else if (findings.length === 0) {
          lines.push(`扫描 ${scanned.length} 个文件，在已实现的规则范围内没有发现问题。`);
        } else {
          lines.push(`扫描 ${scanned.length} 个文件，发现 ${findings.length} 处与硬约束冲突：`);
          let currentFile = null;
          for (const finding of findings) {
            if (finding.file !== currentFile) {
              lines.push("");
              lines.push(`◆ ${finding.file}`);
              currentFile = finding.file;
            }
            lines.push(`  L${finding.line} [${finding.severity}] ${finding.title}`);
            lines.push(`      ${finding.evidence}`);
            lines.push(`      依据：${finding.because}`);
            if (finding.alternative !== undefined) lines.push(`      替代：${finding.alternative}`);
          }
        }

        if (skipped.length > 0) {
          lines.push("");
          const shown = skipped.slice(0, 12);
          lines.push(`跳过 ${skipped.length} 项：${shown.join("；")}${skipped.length > shown.length ? " …" : ""}`);
        }

        lines.push("");
        lines.push(
          `已检查规则（${ruleInventory().length} 条，仅可机械判定者）：${ruleInventory()
            .map((rule) => rule.id)
            .join(" / ")}`,
        );
        lines.push("这是报告不是判决：报告干净不代表实现正确，你可以出于明确的视觉/玩法目的忽略其中某几条。");

        return {
          text: lines.join("\n"),
          ok: true,
          findings: findings.map((f) => ({ ...f })),
          scanned,
          skipped,
        };
      },
    }),
  );

  // ── /vrchat — a human-side probe. A slash command never enters the model
  // turn, so asking "how much am I paying for this block" costs no tokens.
  const commands = ctx.get("commands");
  const tokenMeter = ctx.get("tokenMeter");

  /** Price one system-prompt string through the router's own estimator. */
  const priceText = (text) =>
    tokenMeter?.estimateMessage === undefined
      ? null
      : tokenMeter.estimateMessage({
          role: "system",
          content: [{ type: "text", text }],
          source: { kind: "system-prompt" },
        });

  if (commands !== undefined) {
    ctx.effect(() =>
      commands.register({
        name: "vrchat",
        description: "VRChat 知识库：stats 报 token 与用量 / stale 查语料是否过期 / scan 扫描源文件",
        input: { hint: "stats | stale | scan <path>" },
        handler: (invocation) => {
          const raw = invocation.rawInput.trim();
          const [subcommand, ...rest] = raw.split(/\s+/).filter((part) => part.length > 0);
          const argument = rest.join(" ").trim();

          if (subcommand === undefined || subcommand === "stats") {
            const measured = priceText(sectionText);
            const lines = [
              `VRChat KB · tier=${tier}`,
              `  注入块：${sectionText.length} 字符 / ${measured ?? "—"} tok（router 实测）`,
              `  manifest 估算：${block?.tokensLow ?? "?"}–${block?.tokensHigh ?? "?"} tok（CJK/ASCII 分算）`,
              `  ${provenance}`,
              `  语料：${meta.pageCount} 页，路由 ${data.routes.length} 条，规则 ${ruleInventory().length} 条`,
            ];

            const ledger = readLedger(invocation.agent);
            if (ledger === undefined) {
              lines.push("  本会话用量：不可用（未注册 sessionProjections）");
            } else {
              lines.push(
                `  本会话用量：digest ${ledger.digestCalls} / grep ${ledger.grepCalls} / read ${ledger.readCalls} / scan ${ledger.scanCalls}`,
                `  已查问题：${ledger.queries.length} 条${ledger.queries.length === 0 ? "" : `，最近「${ledger.queries.at(-1).query}」`}`,
              );
            }

            if (tokenMeter !== undefined && invocation.agent?.session !== undefined) {
              try {
                const m = tokenMeter.measure(invocation.agent.session);
                lines.push(
                  `  整会话压力：${m.totalTokens} tok（基线 ${m.baseline.kind}=${m.baseline.tokens}，表面 ${m.surfaceTokens}）`,
                );
              } catch (error) {
                lines.push(`  整会话压力：测量失败（${String(error?.message ?? error)}）`);
              }
            }

            lines.push(`  section 名 = vrchat-kb（预设同名会 shadow 全局）`);
            return { kind: "success", text: lines.join("\n") };
          }

          if (subcommand === "stale") {
            const builtAt = Date.parse(String(meta.builtAt ?? ""));
            const ageDays = Number.isNaN(builtAt) ? null : Math.floor((Date.now() - builtAt) / 86400000);
            return {
              kind: "success",
              text: [
                `语料快照：库 v${meta.libraryVersion ?? "?"} / ${meta.pageCount ?? "?"} 页`,
                `构建时间：${String(meta.builtAt ?? "?")}${ageDays === null ? "" : `（${ageDays} 天前）`}`,
                "若上游知识库已更新，运行 node tools/build-knowledge.mjs 重建并按需重装。",
              ].join("\n"),
            };
          }

          if (subcommand === "scan") {
            if (argument.length === 0) return { kind: "error", text: "用法：/vrchat scan <路径>" };
            return {
              kind: "success",
              text: `请让模型调用 vrchat_kb_scan(paths: ["${argument}"])。斜杠命令不读文件系统，扫描由工具执行。`,
            };
          }

          return {
            kind: "error",
            text: `未知子命令「${subcommand}」。可用：stats / stale / scan <path>`,
          };
        },
      }),
    );
  }
}

export { Config, apply, inject, name };
// bump: force a fresh module generation
