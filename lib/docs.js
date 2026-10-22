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
 * library and are LIBRARY-RELATIVE. Where the corpus physically sits is the
 * plugin's business, so an install path or a submodule path is NOT translated —
 * accepting one would imply the agent should know our filesystem, and would break
 * as soon as the package is installed elsewhere.
 *
 * It must NOT hand the problem back either: an unresolvable path is a plain error
 * naming what was tried, never a list of guesses to pick from.
 */
import { basename } from "node:path";

const MAX_LIMIT = 400;
const DEFAULT_LIMIT = 200;
const MAX_MATCHES = 200;
const MAX_LINE_LENGTH = 200;

/**
 * Map a caller-supplied path onto a library page.
 *
 * Paths are LIBRARY-RELATIVE, and nothing else is accepted as a path. The
 * corpus location is the plugin's business: the tools resolve it internally, and
 * the agent never needs to know where the files sit — not the install directory,
 * not the submodule name, not the versioned folder. Teaching the agent those
 * would be teaching it our filesystem, and it would break on any install path.
 *
 * What IS accepted is the calling conventions an agent already has:
 *   `entities/api/not-exposed`            (extension omitted)
 *   `./entities/api/not-exposed.md`       (explicit relative marker)
 *   `/entities/api/not-exposed.md`        (leading slash = library root)
 *   `not-exposed.md`                      (bare name, only if unambiguous)
 *
 * @param knownPaths - the indexed page paths.
 * @param raw - caller-supplied library-relative path.
 * @returns the library path, or null when nothing resolves.
 */
export function resolvePage(knownPaths, raw) {
  const input = String(raw ?? "").trim().replace(/\\/g, "/");
  if (input.length === 0) return null;

  const known = Array.isArray(knownPaths) ? new Set(knownPaths) : new Set(Object.keys(knownPaths ?? {}));

  // Normalize only the two markers a caller may legitimately prefix with.
  // Anything longer (a drive letter, an install path) stays untouched and will
  // simply fail to resolve, which is the correct answer: it is not our path.
  const stripped = input.replace(/^\.\//, "").replace(/^\//, "");

  for (const variant of [input, stripped]) {
    if (variant.length === 0) continue;
    if (known.has(variant)) return variant;
    if (!variant.toLowerCase().endsWith(".md") && known.has(`${variant}.md`)) {
      return `${variant}.md`;
    }
  }

  // A bare filename resolves only when exactly one page carries it.
  if (!stripped.includes("/")) {
    const hits = [...known].filter((key) => basename(key).toLowerCase() === stripped.toLowerCase());
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
 * Build a failure result with EVERY key the success shape declares.
 *
 * This is not tidiness. `dsh-tools` snapshots a tool's return value before
 * `render` runs, and a property holding `undefined` is not lossless JSON — the
 * whole call then fails with INVALID_TOOL_OUTPUT and the model gets an error
 * code instead of the explanation. The explanations that matter most are exactly
 * the failure ones ("this path is not a library page", "the corpus is missing"),
 * so every key is present with `null` rather than absent.
 *
 * `lines: []` (not null) because the schema declares an array.
 */
function failure(text) {
  return { ok: false, text, path: null, offset: null, totalLines: null, lines: [] };
}

/**
 * Locate where a page's prose starts.
 *
 * All 414 pages carry a YAML frontmatter block (up to 35 lines of title,
 * category, tags, aliases, related links...). It is metadata, not knowledge, so a
 * default read that starts at line 1 spends the first window on it and returns no
 * content at all.
 *
 * The frontmatter is SKIPPED, never renumbered: line numbers stay the file's own
 * numbers so a `grep` hit at line 240 can be read with `offset=240` and land on
 * the same text. Renumbering would break that chaining, which is the whole point
 * of the pair.
 *
 * @param lines - the page split by newline.
 * @returns 1-based line number where prose begins (1 when there is no frontmatter).
 */
export function bodyStartLine(lines) {
  if (lines.length === 0 || lines[0].trim() !== "---") return 1;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index].trim() === "---") return index + 2; // the line AFTER the closing ---
  }
  // An unterminated frontmatter block is a malformed page; treat it as prose so
  // nothing is silently hidden.
  return 1;
}

/**
 * Read one page by line window, in the official `read` shape.
 *
 * Takes a `read` function rather than a page map: page bodies are no longer
 * materialized up front, so a caller passes the lazy reader it already has.
 *
 * @param read - `(path) => string | null`.
 * @param knownPaths - the index paths, used for `resolvePage`.
 * @param raw - caller-supplied path.
 * @param offset - 1-based first line; `undefined` starts at the beginning of the
 *   PROSE, not line 1 (see `bodyStartLine`).
 * @param limit - maximum lines.
 */
export function readPage(read, knownPaths, raw, offset, limit = DEFAULT_LIMIT) {
  const resolved = resolvePage(knownPaths, raw);
  if (resolved === null) {
    return failure(`Cannot read "${String(raw)}": not a library page. Use vrchat_kb_grep to find the library path first.`);
  }

  const body = read(resolved);
  if (body === null) {
    return {
      ...failure(
        `Cannot read "${resolved}": it is in the index but its text is unavailable — the package is missing its corpus checkout.`,
      ),
      path: resolved,
    };
  }

  const lines = body.split("\n");
  const totalLines = lines.length;
  const proseStart = bodyStartLine(lines);
  // An explicit offset is honoured verbatim (so grep's line numbers chain); the
  // DEFAULT jumps past the metadata, which is what makes a plain read useful.
  const start = Number.isInteger(offset) && offset > 0 ? offset : proseStart;
  const count = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT;

  if (start > totalLines && !(totalLines === 0 && start === 1)) {
    return {
      ...failure(`offset ${start} is out of range for "${resolved}" (${totalLines} lines).`),
      path: resolved,
      offset: start,
      totalLines,
    };
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

  // Say the skip once, when it happened silently, so the caller is not surprised
  // that line 1 is missing. Explicit offsets get no note: nothing was skipped.
  const skipNote =
    Number.isInteger(offset) && offset > 0
      ? ""
      : proseStart > 1
        ? `\n(Skipped lines 1-${proseStart - 1} of YAML metadata. Use offset=1 to read it.)`
        : "";

  return {
    ok: true,
    path: resolved,
    offset: start,
    totalLines,
    lines: window,
    // Official `read` presents bare `N: text` rows; the path is in the schema,
    // so repeating it in the body would only cost tokens.
    text: `${window.map((line) => `${line.number}: ${line.text}`).join("\n")}\n${footer}${skipNote}`,
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
export function grepPages(knownPaths, read, pattern, { include, maxMatches = MAX_MATCHES } = {}) {
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
  let unreadable = 0;

  for (const path of knownPaths) {
    if (filter !== null && !filter(path)) continue;
    const body = read(path);
    if (body === null) {
      unreadable++;
      continue;
    }
    const lines = body.split("\n");
    for (let index = 0; index < lines.length; index++) {
      if (!regex.test(lines[index])) continue;
      seen += 1;
      if (matches.length < cap) matches.push({ path, lineNumber: index + 1, line: clip(lines[index]) });
    }
  }

  if (seen === 0) {
    // Distinguish "nothing matched" from "nothing could be read": the second is
    // an install problem the caller must be told about, or it will retry with a
    // better pattern forever against an empty corpus.
    //
    // The wording matters: the corpus ships INSIDE the package, so the fault is
    // never "your workspace lacks the checkout" — it is this installation missing
    // its own files. Saying the wrong one sends the user to fix the wrong thing.
    if (unreadable > 0) {
      return {
        ok: false,
        text: `Cannot search: ${unreadable} page(s) are indexed but their text is unavailable — this installation is missing its bundled corpus.`,
        matches: [],
      };
    }
    return { ok: false, text: "No matches found", matches: [] };
  }

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
