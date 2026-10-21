/**
 * Pure retrieval logic for the VRChat KB. No Harness imports, so `tools/selftest.cjs`
 * exercises exactly what the plugin runs.
 *
 * Three properties matter more than ranking quality, and each is enforced here:
 *
 *   1. A query must COVER a page, not merely touch it. Chinese has no spaces, so
 *      tokenizing produces many bigrams per sentence; "any token appears anywhere"
 *      matched 56% of the corpus and made the coverage-boundary fallback dead code.
 *      Coverage = fraction of query tokens a page actually contains.
 *   2. The author's concept table routes first. It is hand-calibrated keyword →
 *      directory knowledge, and it is the reason the agent never has to know paths.
 *   3. Evidence is returned as whole BLOCKS (heading + its table/list), never lone
 *      lines: a constraint stripped of its table header stops being a constraint.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimum query-token coverage for a page to count as a hit at all. */
const MIN_COVERAGE = 0.5;

/** A token present in more than this share of pages cannot discriminate on its own. */
const MAX_DISCRIMINATING_DF = 0.25;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a matcher for one token.
 *
 * ASCII tokens must match on WORD BOUNDARIES. Substring matching made "rust"
 * match "Trust Rank", which is how an unrelated CI question "found" 25 pages.
 * CJK has no word boundaries, so bigrams stay substring.
 */
export function matcher(token) {
  if (/^[a-z0-9_]+$/.test(token)) {
    const re = new RegExp(`\\b${escapeRegExp(token)}\\b`);
    return (haystack) => re.test(haystack);
  }
  return (haystack) => haystack.includes(token);
}

/** Extra concepts per route row, so Chinese natural-language queries still route. */
const ROUTE_ALIASES = {
  "World/网络": ["同步", "网络", "所有权", "owner", "serialization", "序列化"],
  "World/性能": ["性能", "开销", "gc", "内存", "卡顿"],
  "World/陷阱": ["陷阱", "坑", "静默", "失败"],
  "World/后处理": ["后处理", "模糊", "泛光"],
  "World/Persistence": ["持久化", "存档", "玩家数据", "玩家数据存储", "配額", "配额"],
  "API": ["api", "接口", "方法"],
  "Avatar": ["虚拟形象", "改模", "骨骼", "表情", "avatar"],
  "Shader/Avatar专用": ["着色器", "shader", "poiyomi", "liltoon", "卡通", "toon", "变体"],
  "Shader/World专用": ["世界着色器", "orl", "filamented", "pbr"],
  "Shader/通用": ["毛发", "水面", "草地", "宝石", "无光照"],
  "Hybrid/OSC": ["osc", "音频", "audiolink", "跨域"],
  "VRCGraphics": ["全局", "global", "着色器全局"],
  "VRCCameraSettings": ["相机", "camera"],
  "玩家本地相机工具": ["相机插件", "镜头"],
  "VRCQualitySettings": ["画质", "阴影距离", "质量"],
  "Data Containers": ["数据容器", "容器", "json"],
  "Platform": ["quest", "android", "移动端", "平台", "一体机"],
  "Creator Economy": ["商店", "交易", "售卖"],
  "光照系统": ["光照", "灯光", "light"],
  "World Shader": ["世界shader", "graphlit", "节点"],
  "Udon Example": ["示例", "example", "范例"],
};

/** Load every build artifact once, plus the topical vocabulary derived from it. */
export function createStore(dataDir) {
  const read = (file) => readFileSync(join(dataDir, file), "utf8");
  const index = JSON.parse(read("index.json"));
  const pages = JSON.parse(read("pages.json"));

  // Topical vocabulary = tokens that appear in a title, a tag, or a heading.
  // A Chinese sentence tokenizes into fragment bigrams ("我自", "己写", "写了一")
  // that occur in prose by pure coincidence; they are not topics. Filtering query
  // tokens through this set is what stops a Rust CI question from "matching" an
  // Avatar page and keeps the coverage-boundary fallback reachable.
  const vocabulary = new Set();
  const headings = {};
  const add = (text) => {
    for (const token of rawTokens(text)) vocabulary.add(token);
  };
  for (const entry of index) {
    add(entry.title);
    for (const tag of entry.tags) add(tag);
    const body = pages[entry.path] ?? "";
    const own = [];
    for (const line of body.split("\n")) {
      if (/^#{1,6}\s/.test(line)) {
        add(line);
        own.push(line.replace(/^#{1,6}\s+/, ""));
      }
    }
    headings[entry.path] = own.join("\n").toLowerCase();
  }

  return {
    t0: read("t0-core.txt"),
    alwaysLoad: read("always-load.txt"),
    domainMap: read("domain-map.txt"),
    routes: JSON.parse(read("keyword-routes.json")),
    index,
    pages,
    vocabulary,
    headings,
  };
}

/** Raw CJK bigrams + ASCII words, before any filtering. */
function rawTokens(text) {
  const lowered = String(text ?? "").toLowerCase();
  const tokens = new Set();
  for (const word of lowered.split(/[^a-z0-9_\u4e00-\u9fff]+/)) {
    if (word.length === 0) continue;
    if (/[\u4e00-\u9fff]/.test(word)) {
      for (let i = 0; i + 2 <= word.length; i++) tokens.add(word.slice(i, i + 2));
      if (word.length >= 2) tokens.add(word);
    } else if (word.length > 2) {
      tokens.add(word);
    }
  }
  return [...tokens];
}

/** Query tokens, unfiltered. */
export function tokenize(text) {
  return rawTokens(text);
}

/** Drop tokens that carry no topical signal on their own. */
const STOP = new Set([
  "会怎", "怎样", "怎么", "什么", "多少", "如何", "哪一", "一个", "这个", "那个",
  "可以", "是否", "需要", "自己", "我的", "我们", "请问", "应该", "用的", "用哪",
]);

function meaningful(tokens) {
  const kept = tokens.filter((token) => !STOP.has(token));
  return kept.length > 0 ? kept : tokens;
}

/** Match the author's concept table plus local aliases. */
export function matchRoutes(store, query) {
  const lowered = String(query ?? "").toLowerCase().trim();
  const hits = [];
  for (const route of store.routes) {
    const aliases = ROUTE_ALIASES[route.concept] ?? [];
    const pool = [...route.keywords, ...aliases];
    const matched = pool.filter((keyword) => {
      const needle = keyword.toLowerCase();
      return needle.length >= 2 && lowered.includes(needle);
    });
    if (matched.length > 0) hits.push({ concept: route.concept, target: route.target, matched });
  }
  return hits;
}

function underTarget(path, target) {
  if (target === null || target === undefined) return false;
  const normalized = target.replace(/\.md$/, "");
  return path === `${normalized}.md` || path.startsWith(`${normalized}/`);
}

/** Rank pages by coverage, with routed directories and confidence as boosts. */
export function rank(store, query) {
  const allTokens = meaningful(rawTokens(query));
  const topical = allTokens.filter((token) => store.vocabulary.has(token));
  const routed = matchRoutes(store, query);
  const targets = routed.map((hit) => hit.target);

  // No topical token means the question is outside this library's subject matter.
  // Returning zero hits here is what lets the caller emit the coverage boundary.
  if (topical.length === 0) return { tokens: topical, routed, scored: [] };

  const haystacks = new Map();
  for (const entry of store.index) {
    const body = store.pages[entry.path];
    if (body === undefined) continue;
    haystacks.set(entry.path, `${entry.title}\n${entry.tags.join(" ")}\n${body}`.toLowerCase());
  }

  // Document frequency per query token, computed only for this query.
  const matchers = new Map(topical.map((token) => [token, matcher(token)]));
  const df = new Map();
  for (const token of topical) {
    const test = matchers.get(token);
    let count = 0;
    for (const haystack of haystacks.values()) if (test(haystack)) count++;
    df.set(token, count / Math.max(haystacks.size, 1));
  }
  // A common word ("同步" 48%, "quest" 54%) is on-topic but proves nothing alone;
  // at least one rare word must also be present for an unrouted page to qualify.
  const hasDiscriminating = topical.some((token) => df.get(token) <= MAX_DISCRIMINATING_DF);

  const scored = [];
  for (const entry of store.index) {
    const haystack = haystacks.get(entry.path);
    if (haystack === undefined) continue;

    const present = topical.filter((token) => matchers.get(token)(haystack));
    const coverage = present.length / topical.length;
    const titleHits = topical.filter((token) => matchers.get(token)(entry.title.toLowerCase())).length;
    const tagHits = topical.filter((token) => entry.tags.some((tag) => matchers.get(token)(tag.toLowerCase()))).length;
    const isRouted = targets.some((target) => underTarget(entry.path, target));

    // Admission rule, deliberately strict and explainable:
    //   a page qualifies when the concept table routes to it, or when the query
    //   NAMES it (title/tag), or — for a single-token query — when that one token
    //   is rare and fully covers the page.
    // Matching only in body prose does not qualify. "计算流水线" inside a mesh
    // simplification page must not answer a Rust CI question, and this is the
    // property that keeps the coverage-boundary fallback reachable without
    // breaking long natural-language questions the way an "all tokens present"
    // rule did.
    const admitted =
      coverage > 0 &&
      (isRouted || titleHits > 0 || tagHits > 0 || (hasDiscriminating && topical.length === 1 && coverage === 1));
    if (!admitted) continue;

    const confidenceBoost = entry.confidence === "high" ? 6 : entry.confidence === "medium" ? 3 : 0;
    // Rare tokens outweigh common ones, so a hit on "流水线" beats a hit on "同步".
    const specificity = present.reduce((acc, token) => acc + (1 - Math.min(df.get(token), 1)), 0);

    scored.push({
      entry,
      body: store.pages[entry.path],
      coverage,
      score:
        Math.round(coverage * 60) +
        Math.round(specificity * 30) +
        titleHits * 10 +
        tagHits * 6 +
        (isRouted ? 22 : 0) +
        confidenceBoost,
    });
  }

  scored.sort((a, b) => b.score - a.score || a.entry.path.localeCompare(b.entry.path));
  return { tokens: topical, routed, scored };
}

/**
 * Split a page into self-contained blocks: a heading plus the body it introduces,
 * or a table / list / code fence kept whole. Constraints live in these units.
 */
function blocksOf(body) {
  const out = [];
  const lines = body.split("\n");
  let heading = null;
  let buffer = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text.length > 0) out.push({ heading, text });
    buffer = [];
  };
  let inFence = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      if (!inFence) {
        buffer.push(line);
        flush();
        continue;
      }
      flush();
      buffer.push(line);
      continue;
    }
    if (!inFence && /^#{1,6}\s/.test(line)) {
      flush();
      heading = line.replace(/^#{1,6}\s+/, "").trim();
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

/** The blocks of a page that best answer the query, complete rather than truncated. */
export function bestBlocks(body, tokens, maxBlocks) {
  const candidates = blocksOf(body).map((block) => {
    const lowered = (block.heading ?? "") + "\n" + block.text;
    const hits = tokens.filter((token) => lowered.toLowerCase().includes(token)).length;
    return { ...block, hits };
  });
  const hit = candidates.filter((block) => block.hits > 0);
  if (hit.length === 0) return null;

  hit.sort((a, b) => b.hits - a.hits);
  const picked = hit.slice(0, maxBlocks);
  // Restore reading order so a table header never trails its rows.
  picked.sort((a, b) => candidates.indexOf(a) - candidates.indexOf(b));

  return picked.map((block) => {
    const label = block.heading === null ? "" : `  ▸ ${block.heading}\n`;
    return label + block.text
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n");
  });
}

/** Compose the model-facing answer: digest first, sealed with a stop condition. */
export function answer(store, query, { limit = 4, charBudget = 3200 } = {}) {
  const { tokens, routed, scored } = rank(store, query);

  if (scored.length === 0) {
    return {
      hit: false,
      text: [
        `未命中：本库没有与「${query}」相关的内容。`,
        "",
        store.domainMap,
        "",
        "→ 这是本库的覆盖边界，不代表你检索不够。请直接用通用知识回答，或向用户确认需求，不要重复检索本库。",
      ].join("\n"),
      pageCount: 0,
      routes: routed.map((hitRoute) => hitRoute.concept),
    };
  }

  const head =
    routed.length > 0
      ? `路由命中：${routed.map((hitRoute) => `${hitRoute.concept}(${hitRoute.matched.slice(0, 3).join(",")})`).join(" · ")}`
      : "按全文覆盖率检索。";

  const lines = [head, ""];
  let spent = 0;
  let used = 0;

  for (const item of scored.slice(0, limit)) {
    if (used > 0 && spent >= charBudget) break;
    const label = item.entry.confidence === null ? "" : ` [${item.entry.confidence}]`;
    const blocks = bestBlocks(item.body, tokens, 2);
    lines.push(`◆ ${item.entry.title}${label}`);
    if (blocks === null) {
      lines.push(`  ${item.body.split("\n").find((line) => line.trim().length > 0) ?? ""}`);
    } else {
      for (const block of blocks) {
        lines.push(block);
        spent += block.length;
      }
    }
    used++;
    lines.push("");
  }

  lines.push(
    `以上为本库对「${query}」的全部相关约束（${used} 页，覆盖率排序；[high]/[medium]/[low] 为上游标注可信度）。`,
    "若仍不足，说明本库未覆盖该细节 —— 不要重复检索，直接用通用知识或向用户确认。",
  );

  return {
    hit: true,
    text: lines.join("\n"),
    pageCount: used,
    routes: routed.map((hitRoute) => hitRoute.concept),
  };
}
