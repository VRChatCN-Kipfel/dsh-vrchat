/**
 * VRChat KB — proactive injection + a purpose-built query tool.
 *
 * Division of labour, which is the point of this plugin:
 *   - INJECTION carries only "what exists": red lines and coverage. Never locations.
 *   - The TOOL owns "where is it". The agent never has to read index.md, guess a
 *     path, or grep the submodule to find an answer.
 *
 * Two instances are mounted, and they differ ONLY in whether they inject:
 *
 *   `vrchat-kb`         tier: lite    always on. Registers the six tools and
 *                                    `/vrchat`; injects no prompt text at all.
 *   `vrchat-kb-preset`  tier: preset  inside the VRChat preset. Registers the
 *                                    same tools AND injects the section below.
 *
 * Injection is therefore gated on the PRESET, not on the plugin: the knowledge
 * becomes the agent's identity only when the user asked for it, while the
 * library stays queryable from any session.
 *
 * They share this module file, hence the single module-level store: the corpus
 * belongs to the package, so both instances read the same pages and the same
 * page cache.
 *
 * Retrieval lives in `lib/search.js` (pure, Harness-free) so `tools/selftest.cjs`
 * and `tools/debug-query.cjs` exercise exactly the code the plugin runs.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";
import z from "@deepseek-ai/schemastery";
import { z as zod } from "zod";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createStore, answer, findCorpusRoot } from "./lib/search.js";
import { lintSource, rankFindings, ruleInventory } from "./lib/lint.js";
import { readPage, grepPages } from "./lib/docs.js";
import {
  initLedger,
  applyLedger,
  ledgerView,
  findPriorQuery,
} from "./lib/ledger.js";
import { buildIndex, lookup } from "./lib/api-table.js";
import {
  FILTER_FIELDS,
  validateFilters,
  filterIndex,
  facet,
  describeLibraries,
} from "./lib/metadata.js";
import {
  BRIDGE_TEMPLATES,
  classifyProcess,
  decodeLockfilePid,
  detectCommandLineEvidence,
  detectProjectEvidence,
  inspectLicense,
  renderReport,
} from "./lib/unity-status.js";

const name = "vrchat-kb";

/**
 * Cordis `Inject` is `(keyof M)[] | { [K]: config }` — a plain list of required
 * services. Optional services are NOT declared here: `ctx.get(name)` returns
 * undefined when absent, which is exactly the fallback path.
 */
const inject = ["systemPrompt", "tools"];

const Config = z.object({
  /**
   * Which of the two roles this instance plays.
   *
   *   `lite` / `tools-only`   register the six tools and `/vrchat`, inject
   *                           NOTHING. This is what the always-on row uses, so a
   *                           session that never selects the preset pays only the
   *                           tool definitions.
   *   `preset`                ALSO inject one prompt section (order 640): the
   *                           red lines, or the full digest when tier is `full`.
   *
   * The schema default is `lite`, but `apply()` treats a missing key as
   * `tools-only`; both mean "no injection", so the two defaults agree in effect.
   *
   * `full` is a legacy alias for `preset`: identical behaviour, kept only so an
   * existing config that still says `full` does not silently lose its injection.
   * Do not introduce new uses of it.
   */
  tier: z.string().default("lite"),
  /** Character budget for the evidence returned by one query. */
  charBudget: z.number().default(3200),
  /** Maximum pages returned by one query. */
  maxPages: z.number().default(4),
});

/**
 * The package root — wherever THIS module was installed.
 *
 * Everything the plugin owns is resolved from here: the derived artifacts in
 * `data/`, and the corpus the bundle carries. Never from the session working
 * directory: a user building a world in `E:\projects` still gets this library.
 */
const packageRoot = dirname(fileURLToPath(import.meta.url));
const dataDir = join(packageRoot, "data");

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
  /**
   * Token cost of BOTH blocks, always.
   *
   * A single `blockTokens` field was a mistake: the projection service registers
   * one definition per key and DISCARDS the second (it only bumps `refs`), so
   * whichever instance applied first won and the other's value was lost forever
   * — with `EntryGroup.update` creating rows concurrently, that winner was not
   * even stable. Storing both makes the value order-independent: it no longer
   * depends on which of the two instances happened to run first.
   */
  blockTokensLite: zod.number(),
  blockTokensPreset: zod.number(),
  turn: zod.number(),
  generation: zod.number(),
  queries: zod.array(ledgerEntrySchema),
  digestCalls: zod.number(),
  grepCalls: zod.number(),
  readCalls: zod.number(),
  scanCalls: zod.number(),
});

const ledgerViewSchema = zod.object({
  blockTokensLite: zod.number(),
  blockTokensPreset: zod.number(),
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
  // Only artifacts the bundle still ships. `pages.json` is deliberately absent:
  // page bodies now live in the bundled corpus directory and are read lazily, so
  // requiring it here would fail activation on every fresh install.
  const required = [
    "t0-core.txt",
    "always-load.txt",
    "domain-map.txt",
    "keyword-routes.json",
    "index.json",
    "manifest.json",
    // Optional for activation (the API tool degrades gracefully without it), but
    // listed so a forgotten rebuild reads as a build-step message.
    "api-table.json",
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
let manifest = null;
let apiIndexCache = null;
/** Provenance of the API table (its `source` page), kept for the tool's footer. */
let apiTableMetadata = null;

/**
 * The API availability index, built once from the build artifact.
 *
 * Returns null when the artifact is absent, so the tool degrades to an explicit
 * "table unavailable" answer instead of throwing.
 */
function ensureApiIndex() {
  if (apiIndexCache !== null) return apiIndexCache;
  const file = join(dataDir, "api-table.json");
  if (!existsSync(file)) return null;
  const table = JSON.parse(readFileSync(file, "utf8"));
  apiTableMetadata = table;
  apiIndexCache = buildIndex({
    types: (table.types ?? []).map((type) => ({
      ...type,
      members: (type.members ?? []).map((member) => ({
        raw: member.raw,
        name: member.name,
        kind: member.kind,
        params: [],
      })),
    })),
  });
  return apiIndexCache;
}

/**
 * One store per installed package. There is no workspace key: the corpus
 * belongs to the bundle, so every session in this process shares it.
 */
let store = null;

/**
 * Build (once) the retrieval store over the bundle's own corpus.
 *
 * The corpus is part of the plugin body, so a miss means the install is
 * incomplete — not that the user opened the wrong folder. The tools still work
 * (red lines come from `data/`), but retrieval must say so explicitly instead of
 * returning an empty digest that reads as "the library has nothing on this".
 */
function storeFor() {
  if (store === null) {
    // The PACKAGE root comes from this module's own URL — that is the "outside"
    // part, which must adapt to wherever the package was installed. The "inside"
    // part (which subdirectory holds the corpus) is this library's own layout and
    // stays declared in CORPUS_ENTRY, so a second library cannot leak into it.
    store = createStore(dataDir, findCorpusRoot(packageRoot));
  }
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
 * Run one PowerShell command and return its stdout/stderr/exit code.
 *
 * Spawns `pwsh` DIRECTLY instead of going through `ctx.get("shell")`. The shell
 * service returned an empty process list for a command that the identical argv
 * produces five processes for here: a silent zero with no error attached, which
 * the Unity tool then rendered as "no Unity running" while four were up. Every
 * layer tested fine on its own; only the combination lost data.
 *
 * This is acceptable because the only thing it runs is READ-ONLY enumeration —
 * no writes, no network, no credentials. It is also deliberately NOT a general
 * shell: the callers pass one fixed command each, never user input.
 *
 * @param command - the exact PowerShell text to run.
 * @param signal - caller cancellation.
 * @returns `{ stdout, stderr, exitCode, error }`; `error` is set only on failure.
 */
function runPwshJson(command, signal) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    let child;
    try {
      child = spawn("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
        windowsHide: true,
      });
    } catch (error) {
      finish({ stdout: "", stderr: "", exitCode: null, error: String(error?.message ?? error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    // Bound the wait: a hung pwsh must not hang the tool call.
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ stdout, stderr, exitCode: null, error: "pwsh 超时（20s）" });
    }, 20000);

    const onAbort = () => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
      finish({ stdout, stderr, exitCode: null, error: "调用已取消" });
    };
    signal?.addEventListener?.("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      finish({ stdout, stderr, exitCode: null, error: String(error?.message ?? error) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
      finish({ stdout, stderr, exitCode: code, error: null });
    });
  });
}

/** Copy shown when THIS INSTALLATION lacks its bundled corpus. */
const NO_CORPUS_TEXT =
  "知识库语料不可用：**本插件的安装里缺少自带的语料目录**（`VRChat-Agent-Creator-Library/`）。\n" +  "语料随插件包一起分发，与你在哪个工作区无关——所以这不是你项目的问题，" +
  "而是这次安装没有把语料带下来（打包白名单或 submodule 未初始化）。\n" +
  "处理方式：重装插件；或在本仓库里 `git submodule update --init` 后重新构建安装。\n" +
  "在此之前，注入的红线与人设仍然有效，只是无法检索原文。";

/**
 * Register this instance's injected section and the query tool.
 * @param ctx - agent-scoped services.
 * @param config - which tier this instance stands for.
 */
function apply(ctx, config) {
  assertDataPresent();
  const data = storeFor();
  const meta = ensureManifest();
  // `preset` = mounted inside the VRChat preset; anything else = plain tools only.
  // There is no global injected section on purpose: a session that never opts
  // into the preset should pay nothing, because opting in is what makes this
  // knowledge relevant. Tools stay available either way.
  const tier = typeof config?.tier === "string" ? config.tier : "tools-only";
  const charBudget = Number.isSafeInteger(config?.charBudget) ? config.charBudget : 3200;
  const maxPages = Number.isSafeInteger(config?.maxPages) ? config.maxPages : 4;
  const injectSection = tier === "preset" || tier === "full";

  // The build manifest, not the .md: provenance must describe the artifacts
  // actually shipped. `{{variable}}` would be the "proper" channel, but the
  // prompt interpreter THROWS on an unknown variable or one with no value for an
  // assembly, so a build-static fact is safer as plain substituted text.
  const provenance = [
    `库 v${meta.libraryVersion ?? "?"} / 上游 ${meta.pageCount ?? "?"} 页 / 构建 ${String(meta.builtAt ?? "").slice(0, 10)}`,
    `本块 ${meta.blocks?.["always-load"]?.tokensLow ?? "?"}–${meta.blocks?.["always-load"]?.tokensHigh ?? "?"} tok`,
  ].join(" · ");

  /**
   * The injected section is a SHORT runtime note, not a copy of the red lines.
   *
   * It used to re-emit `t0-core + always-load` — which the persona's suffix
   * already carries verbatim (measured: 99.6% overlap, ~2700–4000 duplicated
   * tokens on every preset session). Two copies of the same constraints also
   * risk contradicting each other the moment one side is edited.
   *
   * So the red lines live in exactly one place (the preset suffix, order 10200,
   * the last word in the prompt) and this section carries only what the suffix
   * cannot: which build is loaded, and where to look when the answer is missing.
   */
  const sectionText = [
    `> VRChat 知识库已挂载（${provenance}）。`,
    "> 红线与领域事实见下方最终约束集；本段只报状态。",
    "> 检索用 `vrchat_kb`（概念）/ `vrchat_kb_api`（API 是否暴露）/ `vrchat_kb_grep`+`_read`（定位）/",
    "> `vrchat_kb_unity`（Unity 运行时）/ `vrchat_kb_scan`（产物违例自查）。" ,
    "> 库未覆盖的部分直说未覆盖，不要用通用 Unity 知识填补。",
    "",
    "> **事实与流程分开取。** 领域事实（参数多少、API 是否暴露、组件语义）查知识库；",
    "> 工作流程（Avatar 的检查 / 诊断 / 审计 / 文档维护，含 FaceEmo、lilycalInventory、",
    "> Modular Avatar 的 provider 手册与验收矩阵）走 `inspect-vrchat-avatar-project` 技能。",
    "> `avatar-audit-methodology` 是那套流程的中文本地化压缩版，只作速查——两者冲突时以技能为准。",
    "",
    "> **技能里的\"必须 Unity MCP\"是标注义务，不是安装义务。** 未连上编辑器时照常做静态取证，",
    "> 但每条结论必须如实标 `STATIC_SOURCE`，Editor 相关的一律标 `MCP_REQUIRED` / `BLOCKED`，",
    "> 不许升格、不许写 `PASS`。装不装桥、走 CLI 还是 batch-mode，由你和用户按当时的条件决定；",
    "> 技能文本禁止的只是「拿离线执行的结果冒充编辑器状态」这件事本身。",
  ].join("\n");

  // In the preset this is the status note; the red lines arrive via the persona
  // suffix. Nothing here duplicates them.
  if (injectSection) {
    ctx.systemPrompt.section({
      name: "vrchat-kb",
      order: 640,
      text: sectionText,
    });
  }

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
        // Both costs are seeded from the build manifest, INDEPENDENT of which
        // tier this instance is: the projection keeps one definition per key, so
        // a value that depended on the mounted tier would be silently replaced by
        // whichever instance registered first.
        init: () =>
          initLedger({
            lite: meta.blocks?.["t0-core"]?.tokensHigh ?? 0,
            preset: meta.blocks?.["always-load"]?.tokensHigh ?? 0,
          }),
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

        // The corpus ships INSIDE this package, so a miss means the installation
        // is incomplete — never that the user opened the wrong folder. Retrieval
        // must say that plainly instead of returning an empty digest that reads
        // as "the library has nothing on this".
        // rather than return an empty digest that looks like "the library has
        // nothing on this".
        const store = storeFor();
        if (store.corpusRoot === null) {
          return { text: NO_CORPUS_TEXT, hit: false, pageCount: 0, routes: [] };
        }

        // `seen`: only meaningful within the SAME turn and the SAME compaction
        // generation — `findPriorQuery` enforces both. Across turns the reply is
        // noise; after compaction the earlier digest was replaced out of the
        // visible conversation, so claiming "already asked" would hand the model
        // a claim it cannot look up. In either case, answer fresh.
        const ledger = readLedger(exec.agent);
        const prior = findPriorQuery(ledger, query);
        if (prior !== undefined) {
          const result = answer(store, query, { limit, charBudget });
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

        const result = answer(store, query, { limit, charBudget });
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
      async execute(args, exec) {
        const pattern = typeof args?.pattern === "string" ? args.pattern.trim() : "";
        if (pattern.length === 0) throw new Error("vrchat_kb_grep requires a non-empty pattern");
        const include = typeof args?.include === "string" ? args.include : undefined;
        // The corpus ships inside this package (see `CORPUS_ENTRY`), so this is
        // the same store every session reads — not a per-workspace one.
        const store = storeFor();
        if (store.corpusRoot === null) return { text: NO_CORPUS_TEXT, ok: false, total: 0, matches: [] };
        const result = grepPages(store.index.map((entry) => entry.path), store.bodyOf, pattern, { include });
        return { text: result.text, ok: result.ok, total: result.total ?? 0, matches: result.matches ?? [] };
      },
    }),
  );

  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_read",
      description:
        "读取 VRChat 知识库中的单个页面，返回带行号的正文。参数与输出对齐内置 read：" +
        "file_path / offset / limit，行格式 `N: 内容`，末尾给出续读提示。\n" +
        "\n" +
        "**默认跳过页面开头的 YAML 元数据。** 每页都有 title/tags/related 之类的 frontmatter（最多 35 行），" +
        "那不是知识正文。不传 offset 时从正文首行开始，并在末尾注明「跳过了第 1–N 行」，" +
        "要读元数据就显式传 offset=1。\n" +
        "\n" +
        "**行号不会因为跳过而漂移：输出的 N 永远是文件里的真实行号**，" +
        "所以 vrchat_kb_grep 报的 `Line 240` 可以直接用 offset=240 读回同一行。" +
        "两种取数方式（默认跳元数据 / 显式 offset）共用同一套行号，不需要换算。\n" +
        "\n" +
        "路径是库内相对的（可用 vrchat_kb_grep 取得），例如 entities/api/not-exposed.md。" +
        "语料随插件包分发，装在哪不需要你知道；也不接受绝对路径或安装路径。",
      parameters: {
        file_path: {
          type: "string",
          required: true,
          description: "库内页面路径，如 entities/api/not-exposed.md（可省略 .md）。不接受安装路径或绝对路径。",
        },
        offset: {
          type: "number",
          description:
            "起始行（1-based），引用文件真实行号。**不传则从正文首行开始，自动跳过 YAML 元数据**；" +
            "传 1 则从文件第 1 行读起（含元数据）。",
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
      async execute(args, exec) {
        const filePath = typeof args?.file_path === "string" ? args.file_path.trim() : "";
        if (filePath.length === 0) throw new Error("vrchat_kb_read requires a non-empty file_path");
        // Deliberately NOT defaulting to 1: `readPage` treats an absent offset as
        // "start at the prose", skipping the YAML metadata every page carries.
        // Substituting 1 here would silently undo that and hand the model a block
        // of frontmatter instead of content.
        const offset = Number.isInteger(args?.offset) ? args.offset : undefined;
        const limit = Number.isInteger(args?.limit) ? args.limit : undefined;
        const store = storeFor();
        if (store.corpusRoot === null) {
          // Every key the success shape declares, with null instead of undefined:
          // `dsh-tools` rejects a result holding undefined with
          // INVALID_TOOL_OUTPUT before `render` runs, which would replace this
          // explanation with an error code. `lines: []` because the schema says
          // array, and `null` for values that are numbers/strings elsewhere.
          return {
            text: NO_CORPUS_TEXT,
            ok: false,
            path: null,
            // Echo the caller's offset only when one was given: reporting "1" for
            // an omitted offset would contradict the tool's own default, which
            // starts at the prose rather than at line 1.
            offset: Number.isInteger(offset) ? offset : null,
            totalLines: null,
            lines: [],
          };
        }
        const result = readPage(store.bodyOf, store.index.map((entry) => entry.path), filePath, offset, limit);
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

  // ── vrchat_kb_api — is this API available in Udon? ────────────────────────
  // Answers ONE question the scan rules cannot: whether an arbitrary type or
  // member appears in the SDK's exposed set. Deliberately separate from
  // `_scan`: scanning decides "this line violates a rule", which needs precision;
  // this reports a data lookup, which may honestly return "no data".
  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_api",
      description:
        "查询某个 Unity / VRChat 类型或成员在 Udon 中是否可用（依据 SDK 3.10.3 已暴露清单，80 个类型 / 1253 个成员）。" +
        "传入 `Type`、`Type.Member` 或裸成员名，如 `Component.CompareTag`、`GetComponent`、`Transform`。" +
        "注意：清单只收录**已暴露**成员，所以「未收录」不等于不可用——工具会明确区分「已暴露 / 类型已知但未列 / 完全无数据」三种情况。" +
        "用于判断某个 API 在 Udon 里能不能用，比凭印象可靠。",
      parameters: {
        query: {
          type: "string",
          required: true,
          description: "类型或成员，如 `Component.CompareTag`、`GetComponent`、`Transform`、`Physics.SphereCast`。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            verdict: { type: "string", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const query = typeof args?.query === "string" ? args.query.trim() : "";
        if (query.length === 0) throw new Error("vrchat_kb_api requires a non-empty query");

        const index = ensureApiIndex();
        if (index === null) {
          return {
            // The table is a derived artifact shipped with the package, so its
            // absence means the install is incomplete — not that the user should
            // run a build. Say what to do, not what a maintainer would do.
            text:
              "API 查表不可用：本安装缺少 `data/api-table.json`（随包分发的派生数据）。\n" +
              "这不是你的操作问题——请重装插件，或检查安装是否被裁剪（package.json 的 `files` 应包含 `data`）。",
            verdict: "unavailable",
          };
        }

        const result = lookup(index, query);
        const lines = [];

        // The table is derived from one page of the corpus, so whether that page
        // is readable is worth saying: a hit here with an unreadable source page
        // means a partial install, not that the answer is untrustworthy.
        const store = storeFor();
        const sourcePage = typeof apiTableMetadata?.source === "string" ? apiTableMetadata.source : null;
        const sourceReadable = sourcePage === null ? null : store.bodyOf(sourcePage) !== null;

        if (result.verdict === "exposed") {
          lines.push(`✅ 「${query}」已暴露，可用。`);
          lines.push(`  所属类型：${result.type}`);
          lines.push(`  匹配签名：`);
          for (const overload of result.overloads.slice(0, 12)) lines.push(`    ${overload}`);
          if (result.overloads.length > 12) lines.push(`    …共 ${result.overloads.length} 个重载`);
        } else if (result.verdict === "not-listed") {
          lines.push(`⚠️ 「${query}」未列入已暴露清单——这不等于不可用。`);
          lines.push(`  ${result.reason}`);
          if (Array.isArray(result.siblingMembers) && result.siblingMembers.length > 0) {
            lines.push(`  该类型下列出的成员可作参照：${result.siblingMembers.slice(0, 12).join("、")}`);
          }
          lines.push(`  若要确认，用 vrchat_kb 查该 API 的文档页，或在 Unity 里编译验证。`);
        } else if (result.verdict === "type") {
          lines.push(`📘 「${result.type}」在清单中，暴露率 ${result.exposureRate ?? "未知"}%。`);
          lines.push(`  本页列出 ${result.memberCount} 个已暴露成员（上游声明 ${result.declaredMemberCount ?? "?"} 个）：`);
          for (const member of result.members.slice(0, 25)) lines.push(`    ${member}`);
          if (result.members.length > 25) lines.push(`    …`);
        } else if (result.verdict === "type-and-member") {
          lines.push(`📘 「${query}」既是类型名也是成员名，两种解读都给出：`);
          lines.push(`  ${result.reason}`);
          lines.push(`  作为成员出现在：${[...new Set(result.overloads ?? [])].slice(0, 6).join("、")}`);
          lines.push(`  类型成员（前 12 条）：`);
          for (const member of (result.members ?? []).slice(0, 12)) lines.push(`    ${member}`);
        } else {
          lines.push(`❓ 无数据：「${query}」`);
          lines.push(`  ${result.reason}`);
          lines.push("  这不代表不可用——清单只覆盖 SDK 3.10.3 的已暴露成员。");
        }

        lines.push("");
        lines.push("（依据 entities/api/exposed-types.md，SDK 3.10.3 已暴露清单；未暴露成员无导出数据。）");
        if (sourceReadable === false) {
          lines.push(
            `⚠️ 但该来源页在当前安装里读不到（语料缺少 \`${String(sourcePage)}\`）：` +
              "查表结果仍可用，原文摘录不可用。可能是安装不完整。",
          );
        } else if (sourceReadable === true && sourcePage !== null) {
          lines.push(`要看原文：\`vrchat_kb_read("${sourcePage}")\`。`);
        }
        return { text: lines.join("\n"), verdict: result.verdict };
      },
    }),
  );

  // ── vrchat_kb_unity — what Unity is actually running right now ───────────
  // Read-only runtime discovery. It answers "which projects are open, under
  // which pid, is an MCP endpoint plausible" and stops there: fetching a token
  // would mean this tool handling credentials, and inspecting the process
  // command line is something the agent can do itself when it needs to.
  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_unity",
      description:
        "查看本机正在运行的 Unity 编辑器 / Unity Hub 进程、它们对应的项目路径、项目的编辑器版本与锁定情况，" +
        "以及「看起来像 MCP 端点」的本地端口（这是可能性，不是证明）。" +
        "只读、不读任何凭据。要确认端点与 token，自己去查对应进程的启动参数与项目配置。" +
        "装了 unity-mcp-cli 的话，它自带的 status 会给出更细的连接状态。",
      parameters: {
        projectPath: {
          type: "string",
          description: "可选：额外检查某个项目目录的编辑器版本与 lockfile 状态。",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            editors: { type: "integer", required: true },
            hubs: { type: "integer", required: true },
            evidence: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args, exec) {
        // Runs `pwsh` DIRECTLY rather than through the `shell` service.
        //
        // The service's round trip returned `{"procs":[],"cli":false}` for a
        // command that the identical argv produced five processes for when spawned
        // here — a silent zero, which this tool then reported as "no Unity running"
        // while four Unity Hub processes were up. Every layer was checked in
        // isolation and behaved correctly; only the combination lost the data, and
        // it never produced an error to explain itself.
        //
        // Enumerating processes READ-ONLY has no security surface, so bypassing the
        // executor does not weaken anything. It also removes the two-step
        // resolve/execute contract whose failure mode was invisible.
        const script =
          "$p = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.Name -like 'Unity*' -or $_.Name -like '*mcp*' } | " +
          "Select-Object ProcessId, Name, ExecutablePath, CommandLine); " +
          "$cli = [bool](Get-Command unity-mcp-cli -ErrorAction SilentlyContinue); " +
          "[pscustomobject]@{ procs = $p; cli = $cli } | ConvertTo-Json -Depth 4 -Compress";

        const outcome = await runPwshJson(script, exec.signal);
        if (outcome.error !== null) {
          return {
            text:
              `探查失败：${outcome.error}\n` +
              "这不是你的操作问题——本工具直接执行 pwsh 未能取得进程列表。" +
              "可以自己跑 `Get-CimInstance Win32_Process` 复核。",
            editors: 0,
            hubs: 0,
            evidence: 0,
          };
        }
        const output = { stdout: { text: outcome.stdout }, stderr: { text: outcome.stderr }, exitCode: outcome.exitCode };

        let snapshot;
        try {
          snapshot = JSON.parse(String(output.stdout?.text ?? "").trim() || "{}");
        } catch {
          return {
            text: `探查失败：无法解析 pwsh 输出。\n${String(output.stderr?.text ?? "").slice(0, 400)}`,
            editors: 0,
            hubs: 0,
            evidence: 0,
          };
        }

        // Diagnostics that explain "found nothing" instead of leaving the caller to
        // guess. A silent zero is the failure mode this tool must never repeat: it
        // once reported "no Unity processes" while four were running.
        const diagnostics = {
          exitCode: output.exitCode,
          timedOut: output.timedOut,
          aborted: output.aborted,
          stdoutChars: String(output.stdout?.text ?? "").length,
          stderrText: String(output.stderr?.text ?? "").slice(0, 300),
          rawProcs: Array.isArray(snapshot.procs) ? snapshot.procs.length : typeof snapshot.procs,
        };

        const rawProcs = Array.isArray(snapshot.procs) ? snapshot.procs : snapshot.procs === undefined ? [] : [snapshot.procs];

        const processes = [];
        for (const raw of rawProcs) {
          const classified = classifyProcess({
            pid: Number(raw.ProcessId),
            name: String(raw.Name ?? ""),
            executablePath: raw.ExecutablePath ?? null,
            commandLine: raw.CommandLine ?? "",
          });
          if (classified === null) continue;
          processes.push(classified);
        }

        // Command-line evidence: a process that names MCP arguments, plus the
        // port that SAME line declares. No port sweep happens here.
        const commandEvidence = [];
        for (const process of processes) {
          for (const match of detectCommandLineEvidence(process)) {
            commandEvidence.push({ pid: process.pid, ...match });
          }
          if (process.kind === "mcp-server") {
            commandEvidence.push({
              pid: process.pid,
              bridgeId: process.bridgeId,
              label: BRIDGE_TEMPLATES.find((b) => b.id === process.bridgeId)?.label ?? process.bridgeId,
              evidence: [`进程名 ${process.name}`],
              port: null,
            });
          }
        }

        // Projects: the ones named on a command line, plus an optional explicit one.
        const projects = [];
        const seen = new Set();
        const addProject = (projectPath, lockedByPid) => {
          if (projectPath === null || seen.has(projectPath)) return;
          seen.add(projectPath);
          const normalized = projectPath.replace(/\\/g, "/");
          let editorVersion = null;
          try {
            const versionFile = join(projectPath, "ProjectSettings", "ProjectVersion.txt");
            if (existsSync(versionFile)) {
              const text = readFileSync(versionFile, "utf8");
              const match = /m_EditorVersion:\s*(\S+)/.exec(text);
              editorVersion = match === null ? null : match[1];
            }
          } catch {
            /* an unreadable project is reported without a version */
          }
          const bridgeEvidence = detectProjectEvidence(
            normalized,
            (p) => readFileSync(p, "utf8"),
            (p) => existsSync(p),
          );
          projects.push({ path: projectPath, editorVersion, lockedByPid, bridgeEvidence });
        };

        for (const process of processes) {
          if (process.projectPath === null) continue;
          addProject(process.projectPath, process.kind === "editor" ? process.pid : null);
        }
        if (typeof args?.projectPath === "string" && args.projectPath.trim().length > 0) {
          addProject(args.projectPath.trim(), null);
        }

        // A live lockfile names the editor pid holding a project.
        for (const project of projects) {
          try {
            const lockFile = join(project.path, "Temp", "UnityLockfile");
            if (!existsSync(lockFile)) continue;
            const pid = decodeLockfilePid(new Uint8Array(readFileSync(lockFile)));
            if (pid !== null) project.lockedByPid = pid;
          } catch {
            /* a stale or unreadable lockfile leaves the state unknown */
          }
        }

        // The license is checked on every run: an expired one makes Unity refuse
        // to open a project and fail builds, with errors that point at the project.
        // Only the DATE fields are read — the .ulf file holds keys and they are
        // never touched.
        const license = inspectLicense({
          programData: process.env.ProgramData ?? "C:\\ProgramData",
          exists: (p) => existsSync(p),
          readText: (p) => {
            try {
              return readFileSync(p, "utf8");
            } catch {
              return null;
            }
          },
        });

        const text = renderReport({
          processes,
          projects,
          commandEvidence,
          cliDetected: snapshot.cli === true,
          diagnostics,
          license,
        });

        return {
          text,
          editors: processes.filter((p) => p.kind === "editor").length,
          hubs: processes.filter((p) => p.kind === "hub").length,
          evidence: commandEvidence.length + projects.reduce((acc, p) => acc + p.bridgeEvidence.length, 0),
        };
      },
    }),
  );

  // ── vrchat_kb_filter — query the metadata as a FILTER, not as text ────────
  // Every page carries ~35 lines of YAML frontmatter that `read` skips as
  // non-content. Searching those words with grep is noise (`last_review` matches
  // all 414 pages), but filtering on them is precise: `status: deprecated` is one
  // page out of 414, a fact no text search can express.
  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_filter",
      description:
        "按元数据筛选知识库页面，返回匹配的库内路径与标题（不含正文）。用于「哪些页是 high 可信度」「Quest 相关的 deprecated 页有哪些」" +
        "这类结构化问题——这类词在每页的 YAML 元数据里，用 grep 搜会命中全部 414 页，只有筛选才有意义。\n" +
        "\n" +
        "可筛选字段：type / category / confidence / status / tags / title / path。" +
        "多个字段之间是 AND；tags 给多个值时要求全部命中。字段名拼错会报错并列出可用字段，不会静默返回全部。\n" +
        "\n" +
        "只要 buckets 想看分布（比如「有哪些 category」），把 filters 留空并传 buckets。",
      parameters: {
        filters: {
          type: "object",
          description:
            "筛选条件。例：{\"confidence\":\"high\",\"category\":\"world\"}。可用键：" +
            "type / category / confidence / status / tags（数组）/ title / path。留空=全部。",
          properties: {
            type: { type: "string", description: "entity / concept / governance / navigation / summary" },
            category: { type: "string", description: "world / avatar / api / patterns / platform / rules / hybrid / misc / meta" },
            confidence: { type: "string", description: "high / medium / low" },
            status: { type: "string", description: "active / draft / deprecated" },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "标签数组，要求全部命中，如 [\"sync\",\"performance\"]。",
            },
            title: { type: "string", description: "标题子串（大小写不敏感）" },
            path: { type: "string", description: "库内路径子串，如 entities/api" },
          },
          additionalProperties: false,
        },
        buckets: {
          type: "array",
          items: { type: "string" },
          description: "可选：额外返回这些字段的取值分布，如 [\"category\",\"confidence\"]。",
        },
        limit: { type: "number", description: "最多返回条数，默认 40，上限 200。" },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            count: { type: "integer", required: true },
            paths: { type: "array", items: { type: "string" }, required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute(args) {
        const store = storeFor();
        if (store.corpusRoot === null) {
          return { text: NO_CORPUS_TEXT, count: 0, paths: [] };
        }

        const filters = args?.filters === undefined ? {} : args.filters;
        const invalid = validateFilters(filters);
        if (invalid !== null) {
          return { text: `筛选条件无效：${invalid}`, count: 0, paths: [] };
        }

        const matched = filterIndex(store.index, filters);
        const cap = Number.isSafeInteger(args?.limit) && args.limit > 0 ? Math.min(args.limit, 200) : 40;
        const shown = matched.slice(0, cap);

        const lines = [];
        const label = Object.keys(filters).length === 0 ? "全部" : JSON.stringify(filters);
        lines.push(`筛选 ${label} → ${matched.length} 页${matched.length > shown.length ? `（列出前 ${shown.length}）` : ""}`);

        if (matched.length > 0) {
          lines.push("");
          for (const entry of shown) {
            const bits = [entry.type, entry.category, entry.confidence, entry.status].filter((x) => x !== null && x !== undefined);
            lines.push(`  ${entry.path}`);
            lines.push(`    ${entry.title}  [${bits.join(" · ")}]`);
          }
          if (matched.length > shown.length) lines.push(`  … 还有 ${matched.length - shown.length} 页`);
        }

        // Buckets answer "what values exist" without the caller guessing and
        // getting an empty result from a misspelled enum.
        const bucketFields = Array.isArray(args?.buckets) ? args.buckets.filter((f) => typeof f === "string") : [];
        for (const field of bucketFields) {
          const unknown =
            !Object.hasOwn(FILTER_FIELDS, field) && !["title", "path"].includes(field) && field !== "tags";
          if (unknown) {
            lines.push("");
            lines.push(`  分布「${field}」：字段不存在。可用：${Object.keys(FILTER_FIELDS).join(", ")}`);
            continue;
          }
          const counts = facet(store.index, field);
          lines.push("");
          lines.push(`  分布「${field}」（${counts.length} 种）：`);
          for (const [value, count] of counts.slice(0, 20)) lines.push(`    ${String(count).padStart(4)}  ${value}`);
          if (counts.length > 20) lines.push(`    … 还有 ${counts.length - 20} 种`);
        }

        lines.push("");
        lines.push("要看正文：把上面的路径交给 `vrchat_kb_read`。");

        return { text: lines.join("\n"), count: matched.length, paths: shown.map((entry) => entry.path) };
      },
    }),
  );

  // ── vrchat_kb_list — what knowledge is loaded, at a glance ───────────────
  // "Which libraries do I have" is a runtime fact, not a build fact: a second
  // library would appear here as another line, which is why the description comes
  // from the store rather than from the shipped manifest.
  ctx.tools.register(
    defineTool({
      name: "vrchat_kb_list",
      description:
        "列出当前已加载的知识库及其概况：版本、页数、构建日期、分类与类型分布、可信度分布，" +
        "并提示有多少 draft / deprecated 页（引用前该先看 status）。" +
        "不确定「这里有什么可查」时先调它，比直接检索更省。\n" +
        "\n" +
        "只报告已加载的库；若本安装缺少自带语料，会明说缺少而不是列空。",
      parameters: {},
      output: {
        schema: {
          type: "object",
          additionalProperties: true,
          properties: {
            text: { type: "string", required: true },
            libraries: { type: "integer", required: true },
            pages: { type: "integer", required: true },
          },
        },
        render: (_args, value) => [{ type: "text", text: value.text }],
      },
      async execute() {
        const store = storeFor();
        const text = describeLibraries({
          manifest: meta,
          index: store.index,
          corpusRoot: store.corpusRoot,
          dataDir,
        });
        return {
          text,
          libraries: store.corpusRoot === null ? 0 : 1,
          pages: store.corpusRoot === null ? 0 : store.index.length,
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
              `  本段（order 640，运行时状态）：${sectionText.length} 字符 / ${measured ?? "—"} tok（router 实测）`,
              // The red lines arrive through the PRESET's persona suffix, not this
              // section; report that budget separately so it is not mistaken for
              // this section's size.
              `  预设人设注入（prefix + suffix）：${meta.presetPayload?.estimatedTokensLow ?? "?"}–${meta.presetPayload?.estimatedTokensHigh ?? "?"} tok`,
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
                // Both tiers are reported: one field could not represent two
                // mounts, because the projection keeps one definition per key.
                `  各档位注入量：lite ${ledger.blockTokensLite} tok / preset ${ledger.blockTokensPreset} tok`,
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
