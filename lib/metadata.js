/**
 * Structured filtering over the index metadata.
 *
 * WHY THIS IS NOT grep: every page carries ~35 lines of YAML frontmatter, and
 * `read` deliberately skips it as non-content. So searching those words as TEXT
 * is noise — `last_review` matches 414 pages and tells you nothing about the
 * content. But the SAME metadata is precise when used as a FILTER: `status:
 * deprecated` is one page out of 414, and that is a fact you cannot find any other
 * way.
 *
 * The index already carries the fields this needs (built by the generator from the
 * frontmatter), so nothing here re-parses pages.
 */

/** The fields the index records, and therefore the fields a filter may name. */
export const FILTER_FIELDS = {
  type: "页面类型：entity / concept / governance / navigation / summary",
  category: "主题分类：world / avatar / api / patterns / platform / rules / hybrid / misc / meta …",
  confidence: "可信度：high / medium / low",
  status: "状态：active / draft / deprecated",
  tags: "标签数组，可给多个，要求全部命中",
};

/** Free-text fields, matched as a case-insensitive substring. */
const TEXT_FIELDS = new Set(["title", "path"]);

/**
 * Reject unknown field names instead of silently ignoring them.
 *
 * A typo like `confidance` silently returning "everything" is worse than an
 * error: the caller concludes there are 414 high-confidence pages.
 *
 * @param filters - caller-supplied `{ field: value }`.
 * @returns an error message, or null when every field is known.
 */
export function validateFilters(filters) {
  if (filters === null || typeof filters !== "object") return "filters must be an object";
  const known = new Set([...Object.keys(FILTER_FIELDS), ...TEXT_FIELDS]);
  const unknown = Object.keys(filters).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    return `unknown filter field(s): ${unknown.join(", ")}. Known: ${[...known].join(", ")}`;
  }
  return null;
}

/**
 * Apply filters to the index.
 *
 * Semantics: every filter must match (AND). `tags` additionally requires ALL of
 * its values, because "sync AND performance" is the useful question and "sync OR
 * performance" is what a text search already gives.
 *
 * @param index - entries from `data/index.json`.
 * @param filters - `{ type?, category?, confidence?, status?, tags?, title?, path? }`.
 * @returns the matching entries, in index order.
 */
export function filterIndex(index, filters = {}) {
  const entries = Object.entries(filters).filter(([, value]) => value !== undefined && value !== null);
  if (entries.length === 0) return index;

  return index.filter((entry) =>
    entries.every(([key, wanted]) => {
      if (key === "tags") {
        const required = Array.isArray(wanted) ? wanted : [wanted];
        const have = new Set((entry.tags ?? []).map((tag) => String(tag).toLowerCase()));
        return required.every((tag) => have.has(String(tag).toLowerCase()));
      }
      const actual = entry[key];
      if (TEXT_FIELDS.has(key)) {
        const haystack = Array.isArray(actual) ? actual.join(" ") : String(actual ?? "");
        return haystack.toLowerCase().includes(String(wanted).toLowerCase());
      }
      // Scalar enum fields compare case-insensitively: frontmatter is inconsistent
      // (`High` and `high` both appear), and the index normalizes some but not all.
      return String(actual ?? "").toLowerCase() === String(wanted).toLowerCase();
    }),
  );
}

/**
 * Count how many entries carry each value of a field.
 *
 * Used to answer "what categories exist" without the caller having to guess
 * values and get empty results.
 *
 * @param index - entries from `data/index.json`.
 * @param field - one of the filterable fields, or `tags`.
 * @returns value → count, most frequent first.
 */
export function facet(index, field) {
  const counts = new Map();
  for (const entry of index) {
    if (field === "tags") {
      for (const tag of entry.tags ?? []) {
        const key = String(tag);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    } else {
      const key = String(entry[field] ?? "(none)");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts].sort((a, b) => b[1] - a[1]);
}

/**
 * Describe the loaded libraries.
 *
 * "Library" rather than "corpus": a second knowledge library would appear here as
 * another line, which is the point of keeping the corpus path declarative.
 *
 * @param inputs - `{ manifest, index, corpusRoot, dataDir }`.
 */
export function describeLibraries({ manifest, index, corpusRoot, dataDir }) {
  const lines = [
    `已加载 ${corpusRoot === null ? 0 : 1} 个知识库`,
    "",
  ];

  if (corpusRoot === null) {
    lines.push("  （本安装缺少自带语料目录，见 vrchat_kb 的提示）");
    return lines.join("\n");
  }

  const byCategory = facet(index, "category");
  const byType = facet(index, "type");
  const byConfidence = facet(index, "confidence");

  lines.push(`◆ VRChat 创作知识库  v${manifest.libraryVersion ?? "?"}`);
  lines.push(`  页数：${index.length}`);
  lines.push(`  构建：${String(manifest.builtAt ?? "").slice(0, 10)}`);
  // Report the UPSTREAM identity, not manifest.corpusRoot: that field is our
  // install layout (`.../memoryV5.0.0/LLMWikiPage/...`) and telling the model our
  // filesystem is exactly what the path contract forbids.
  lines.push(`  上游：RhineLab-magellan/VRChat-Agent-Creator-Library v${manifest.libraryVersion ?? "?"}`);
  lines.push("");
  lines.push(`  分类（${byCategory.length} 种）：`);
  for (const [value, count] of byCategory) lines.push(`    ${String(count).padStart(4)}  ${value}`);
  lines.push("");
  lines.push(`  类型：${byType.map(([value, count]) => `${value} ${count}`).join(" / ")}`);
  lines.push(`  可信度：${byConfidence.map(([value, count]) => `${value} ${count}`).join(" / ")}`);

  const draft = index.filter((entry) => entry.status === "draft").length;
  const deprecated = index.filter((entry) => entry.status === "deprecated").length;
  if (draft + deprecated > 0) {
    lines.push(`  ⚠️ 其中 draft ${draft} 页 / deprecated ${deprecated} 页（引用前先看 status）`);
  }

  return lines.join("\n");
}
