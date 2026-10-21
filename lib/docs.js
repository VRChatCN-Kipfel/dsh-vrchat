/**
 * Library-scoped document access — the rung the design was missing.
 *
 *   vrchat_kb       digest: what the library says about a question
 *   vrchat_kb_grep  line-numbered hits, grouped by page
 *   vrchat_kb_read  read a page by line window, numbered
 *
 * `grep` and `read` MIRROR the official tools: same parameter names and the
 * same output conventions (`Found N matches` + `path` / `Line N: text` groups;
 * numbered lines + `(End of file - total N lines)` footer). Whatever the agent
 * already knows about paging and searching transfers for free, and "should I
 * read the whole thing" stays its own decision.
 *
 * The ONE thing this layer owns is path resolution: paths are confined to the
 * library, and built-in locations (a submodule-relative path, an absolute path
 * under `LLMWikiPage/`) are translated, so the caller never has to know where
 * the corpus lives. It must NOT hand the problem back — an unresolvable path is
 * a plain error naming what was tried, never a list of guesses to pick from.
 */
import { basename } from "node:path";

const MAX_LIMIT = 400;
const DEFAULT_LIMIT = 200;
const MAX_MATCHES = 200;
const MAX_LINE_LENGTH = 200;

/**
 * Map a caller-supplied path onto a library page.
 *
 * Translation, not guessing: strip the known corpus roots, add `.md`, and try.
 * A miss returns `null`; the caller reports what it tried.
 *
 * @param pages - path → body map.
 * @param raw - caller-supplied path, possibly absolute or submodule-relative.
 * @returns the library path, or null when nothing translates.
 */
export function resolvePage(pages, raw) {
  const input = String(raw ?? "").trim().replace(/\\/g, "/");
  if (input.length === 0) return null;

  const stripped = input
    .replace(/^[A-Za-z]:\//, "")
    .replace(/^.*?LLMWikiPage\//i, "")
    .replace(/^.*?memoryV5\.0\.0\//i, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "");

  for (const variant of [input, stripped]) {
    if (variant.length === 0) continue;
    if (Object.hasOwn(pages, variant)) return variant;
    if (!variant.toLowerCase().endsWith(".md") && Object.hasOwn(pages, `${variant}.md`)) {
      return `${variant}.md`;
    }
  }

  // A bare filename translates only when exactly one page carries it.
  if (!stripped.includes("/")) {
    const hits = Object.keys(pages).filter((key) => basename(key).toLowerCase() === stripped.toLowerCase());
    if (hits.length === 1) return hits[0];
  }

  return null;
}

/** Keep one line's text within the rendering budget. */
function clip(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH)}…` : trimmed;
}

/**
 * Read one page by line window, in the official `read` shape.
 * @param pages - path → body map.
 * @param raw - caller-supplied path.
 * @param offset - 1-based first line.
 * @param limit - maximum lines.
 */
export function readPage(pages, raw, offset = 1, limit = DEFAULT_LIMIT) {
  const resolved = resolvePage(pages, raw);
  if (resolved === null) {
    return { ok: false, text: `Cannot read "${String(raw)}": not a library page. Use vrchat_kb_grep to find the library path first.` };
  }

  const lines = pages[resolved].split("\n");
  const totalLines = lines.length;
  const start = Number.isInteger(offset) && offset > 0 ? offset : 1;
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

  if (start > totalLines && !(totalLines === 0 && start === 1)) {
    return { ok: false, text: `offset ${start} is out of range for "${resolved}" (${totalLines} lines).` };
  }

  const end = Math.min(totalLines, start + count - 1);
  const window = [];
  for (let number = start; number <= end; number++) {
    window.push({ number, text: lines[number - 1] ?? "" });
  }

  const footer =
    end < totalLines
      ? `(Showing lines ${start}-${end} of ${totalLines}. Use offset=${end + 1} to continue.)`
      : `(End of file - total ${totalLines} lines)`;

  return {
    ok: true,
    path: resolved,
    offset: start,
    totalLines,
    lines: window,
    // Official `read` presents bare `N: text` rows; the path is in the schema,
    // so repeating it in the body would only cost tokens.
    text: `${window.map((line) => `${line.number}: ${line.text}`).join("\n")}\n${footer}`,
  };
}

/**
 * Compile one glob into a RegExp.
 * Character-class syntax (`[.]`) is used instead of backslash escapes so no
 * escaping pass can double-escape it, and `*` alone spans directory segments.
 */
function globToRegExp(glob) {
  let source = "";
  for (const ch of glob) {
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (/[.+^${}()|[\]\\]/.test(ch)) source += `[${ch}]`;
    else source += ch;
  }
  return new RegExp(`^${source}$`, "i");
}

/** Map one `include` filter onto a library path. */
function includeFilter(include) {
  const raw = String(include ?? "").trim();
  if (raw.length === 0) return null;

  // Expand `{a,b}` alternation wherever it appears, keeping any suffix:
  // `{index,limits}.md` → `index.md`, `limits.md`.
  const expanded = [];
  const brace = /\{([^}]+)\}/.exec(raw);
  if (brace === null) {
    expanded.push(raw);
  } else {
    for (const part of brace[1].split(",")) {
      expanded.push(`${raw.slice(0, brace.index)}${part.trim()}${raw.slice(brace.index + brace[0].length)}`);
    }
  }

  // Strip only directory prefixes (`./`, `**/`, `/`). A leading `*` belongs to
  // the GLOB, not the path prefix — eating it would turn `*.md` into `.md`.
  const tests = expanded.map((glob) => globToRegExp(glob.replace(/^(?:\.\/|\*\*\/|\/)/, "")));

  return (path) =>
    tests.some((test) => test.test(path)) || tests.some((test) => test.test(basename(path)));
}

/**
 * Search pages, in the official `grep` shape: grouped by file, `Line N: text`.
 * @param pages - path → body map.
 * @param pattern - regular expression source.
 * @param options - optional `include` filter and match cap.
 */
export function grepPages(pages, pattern, { include, maxMatches = MAX_MATCHES } = {}) {
  let regex;
  try {
    regex = new RegExp(pattern, "i");
  } catch (error) {
    return { ok: false, text: `Invalid regular expression: ${String(error?.message ?? error)}`, matches: [] };
  }

  const filter = includeFilter(include);
  const cap = Number.isInteger(maxMatches) && maxMatches > 0 ? Math.min(maxMatches, MAX_MATCHES) : MAX_MATCHES;
  const matches = [];
  let seen = 0;

  for (const [path, body] of Object.entries(pages)) {
    if (filter !== null && !filter(path)) continue;
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!regex.test(lines[index])) continue;
      seen += 1;
      if (matches.length < cap) matches.push({ path, lineNumber: index + 1, line: clip(lines[index]) });
    }
  }

  if (seen === 0) return { ok: false, text: "No matches found", matches: [] };

  // Group by file, first-seen order — the official body layout.
  const byFile = new Map();
  for (const match of matches) {
    const group = byFile.get(match.path);
    if (group === undefined) byFile.set(match.path, [match]);
    else group.push(match);
  }
  const body = [...byFile]
    .map(([path, group]) => `${path}\n${group.map((m) => `Line ${m.lineNumber}: ${m.line}`).join("\n")}`)
    .join("\n\n");

  const header = seen > matches.length ? `Found ${matches.length} of ${seen} matches` : `Found ${seen} ${seen === 1 ? "match" : "matches"}`;
  const tail =
    seen > matches.length
      ? "\n\n(The complete result was not retained; narrow the pattern or include to see more.)"
      : "\n\n(Use vrchat_kb_read with file_path and offset to read around a match.)";

  return { ok: true, matches, total: seen, text: `${header}\n\n${body}${tail}` };
}
