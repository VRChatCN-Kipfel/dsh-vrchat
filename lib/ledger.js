/**
 * Turn-scoped query ledger — the state behind BOTH the Chat row and `seen`.
 *
 * TWO CORRECTNESS RULES, both learned the hard way:
 *
 * 1. SCOPE IS THE TURN, NOT THE SESSION AND NOT THE STEP.
 *    A "you already asked this" reply is only meaningful inside the same turn,
 *    where the earlier answer is still in the conversation the model can see.
 *    Across turns it is noise; and a *step* is too narrow, since one turn spans
 *    many steps and re-asking between them is exactly the waste to avoid.
 *
 * 2. COMPACTION INVALIDATES THE MEMORY.
 *    Compaction replaces the message span (`surfaceOp: replace`), so the earlier
 *    digest is GONE from what the model can see. Answering "already queried"
 *    then hands it a claim it cannot verify — worse than useless. The fold
 *    therefore bumps a generation on `compaction/start`, and a prior query only
 *    counts when its generation still matches.
 *
 * It folds EXISTING session event types only (`tool/call`, `turn/start`,
 * `compaction/start`). Appending a custom type would leave an unknown stored
 * event without `ignorable: true`, and the Session would refuse to reopen —
 * and live `append()` cannot set that marker.
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
    version: 2,
    blockTokens: Number.isFinite(blockTokens) ? blockTokens : 0,
    turn: 0,
    generation: 0,
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

  // A new turn: earlier turns' queries stop being "already asked".
  if (event.type === "turn/start") {
    const turn = Number.isFinite(event.data?.turn) ? event.data.turn : state.turn + 1;
    if (turn === state.turn) return state;
    return { ...state, turn };
  }

  // Compaction replaced the visible span: nothing remembered this turn can be
  // referred back to, because the model can no longer see it.
  if (event.type === "compaction/start") {
    return { ...state, generation: state.generation + 1, queries: [] };
  }

  if (event.type !== "tool/call") return state;

  const data = event.data ?? {};
  const counter = TRACKED[data.name];
  if (counter === undefined) return state;

  const next = { ...state, [counter]: state[counter] + 1 };
  if (data.name !== "vrchat_kb") return next;

  const args = parseArguments(data.arguments);
  if (args === undefined) return next;

  const normalized = normalizeQuery(args.query);
  if (normalized.length === 0) return next;

  const priorIndex = state.queries.findIndex(
    (entry) =>
      entry.normalized === normalized &&
      entry.turn === state.turn &&
      entry.generation === state.generation,
  );
  if (priorIndex >= 0) {
    const queries = state.queries.slice();
    queries[priorIndex] = { ...queries[priorIndex], at: event.time ?? queries[priorIndex].at };
    return { ...next, queries };
  }

  const entry = {
    normalized,
    query: String(args.query ?? "").slice(0, MAX_QUERY_CHARS),
    turn: state.turn,
    generation: state.generation,
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
    turn: state.turn,
    digestCalls: state.digestCalls,
    grepCalls: state.grepCalls,
    readCalls: state.readCalls,
    scanCalls: state.scanCalls,
    lastQuery: latest === null ? null : latest.query,
  };
}

/**
 * Has this question already been answered where the model can still see it?
 *
 * Answers only when the prior query is in the SAME turn AND the same compaction
 * generation. Anything else must be answered fresh: a reply the model cannot
 * look up is worse than re-sending the digest.
 *
 * @param state - ledger state, or undefined when no projection is available.
 * @param query - the caller's raw query.
 * @returns the matching prior entry, or undefined.
 */
export function findPriorQuery(state, query) {
  if (state === null || state === undefined) return undefined;
  const normalized = normalizeQuery(query);
  if (normalized.length === 0) return undefined;
  return state.queries.find(
    (entry) =>
      entry.normalized === normalized &&
      entry.turn === state.turn &&
      entry.generation === state.generation,
  );
}
