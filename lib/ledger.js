/**
 * Session-scoped query ledger — the state behind BOTH the Chat row and `seen`.
 *
 * One fold serves two features on purpose:
 *   - the Chat row shows what the library cost this session;
 *   - `seen` is "have I already answered this question in this session", which
 *     stops a re-query from paying for the same digest twice.
 *
 * CRITICAL: it folds EXISTING session event types only (`tool/call`). The
 * practices doc forbids appending a new event `type` — a stored event with an
 * unknown type and no `ignorable` marker makes the Session refuse to reopen,
 * and live `append()` cannot set that marker. Tool calls are already logged, so
 * a fold over `tool/call` needs no new event and survives resume, fork, and
 * replay for free.
 */

/** Longest query string kept per entry, so a huge query cannot bloat the log. */
const MAX_QUERY_CHARS = 160;

/** How many recent queries the ledger remembers. */
const MAX_ENTRIES = 40;

/** Tool names this ledger tracks. */
const TRACKED = {
  vrchat_kb: "digestCalls",
  vrchat_kb_grep: "grepCalls",
  vrchat_kb_read: "readCalls",
  vrchat_kb_scan: "scanCalls",
};

/**
 * Normalize a query so trivial variations count as the same question.
 *
 * Order matters: punctuation is removed FIRST, then whitespace is collapsed.
 * Doing it the other way leaves the gap punctuation used to occupy as a stray
 * space, so "会怎样？" and "会怎样" would normalize differently.
 */
export function normalizeQuery(query) {
  return String(query ?? "")
    .toLowerCase()
    .replace(/[，,。.！!？?；;：:"'`「」『』()（）\[\]【】]/g, "")
    .replace(/[\s\u3000]+/g, " ")
    .trim()
    .slice(0, MAX_QUERY_CHARS);
}

/** Initial ledger state for one session. */
export function initLedger(blockTokens) {
  return {
    version: 1,
    blockTokens: Number.isFinite(blockTokens) ? blockTokens : 0,
    queries: [],
    digestCalls: 0,
    grepCalls: 0,
    readCalls: 0,
    scanCalls: 0,
  };
}

/** Pull a tool call's arguments object out of its logged JSON string. */
function parseArguments(raw) {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fold one committed session event into the state.
 *
 * @param state - current ledger state.
 * @param event - one committed session event.
 * @returns the next state, or the same reference when the event is irrelevant.
 */
export function applyLedger(state, event) {
  if (state === null || state === undefined) return state;
  if (event === null || typeof event !== "object") return state;
  // Only `tool/call` is folded: it is already logged, so no custom event type
  // is introduced and the session stays reopenable.
  if (event.type !== "tool/call") return state;

  const data = event.data ?? {};
  const counter = TRACKED[data.name];
  if (counter === undefined) return state;

  const args = parseArguments(data.arguments);
  const next = { ...state, [counter]: state[counter] + 1 };

  // Only the digest tool takes a free-form query worth remembering.
  if (data.name !== "vrchat_kb" || args === undefined) return next;

  const normalized = normalizeQuery(args.query);
  if (normalized.length === 0) return next;

  const priorIndex = state.queries.findIndex((entry) => entry.normalized === normalized);
  if (priorIndex >= 0) {
    // A repeat refreshes recency but does not grow the ledger.
    const queries = state.queries.slice();
    queries[priorIndex] = { ...queries[priorIndex], at: event.time ?? queries[priorIndex].at };
    return { ...next, queries };
  }

  const entry = {
    normalized,
    query: String(args.query ?? "").slice(0, MAX_QUERY_CHARS),
    at: event.time ?? 0,
  };
  return { ...next, queries: [...state.queries, entry].slice(-MAX_ENTRIES) };
}

/**
 * The client-facing view. Kept tiny: the dock renders one line.
 * @param state - ledger state.
 */
export function ledgerView(state) {
  const latest = state.queries.length === 0 ? null : state.queries[state.queries.length - 1];
  return {
    blockTokens: state.blockTokens,
    digestCalls: state.digestCalls,
    grepCalls: state.grepCalls,
    readCalls: state.readCalls,
    scanCalls: state.scanCalls,
    lastQuery: latest === null ? null : latest.query,
  };
}

/**
 * Has this question already been answered in this session?
 * @param state - ledger state, or undefined when no projection is available.
 * @param query - the caller's raw query.
 * @returns the matching prior entry, or undefined.
 */
export function findPriorQuery(state, query) {
  if (state === null || state === undefined) return undefined;
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return undefined;
  return state.queries.find((entry) => entry.normalized === normalized);
}
