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

/**
 * Initial ledger state for one session.
 *
 * `injectedChars` is what THIS session actually received, not what this tier
 * could have injected. Getting that distinction wrong was visible in the UI: the
 * always-on row injects nothing, but the ledger was seeded from `t0-core`'s size,
 * so every ordinary session displayed "≥920 tok" for an injection of zero.
 *
 * Two consequences the caller must respect:
 *
 * 1. A `lite` session passes 0. There is nothing to inject — the section is only
 *    registered for the preset — so 0 is the honest number, and the client uses
 *    it to decide whether the dock should render at all.
 * 2. A subagent session passes 0 too, even though it may carry a preset: no
 *    section is registered inside the child's own context, so the child pays
 *    nothing for this block. Aggregating a parent's cost onto a child would
 *    double-count what the parent already paid.
 *
 * Deliberately NO per-tier fields. Earlier this carried `blockTokensLite` and
 * `blockTokensPreset`, because a single mount-order-dependent value could not
 * represent both rows. But only one of those values was ever true for any given
 * session, and the client had no way to tell which — so it showed the smaller
 * one, which was the false one. A session knows its own cost; it does not need
 * to carry the other tier's.
 *
 * @param options - `{ injectedChars, role, parentSession }`. A bare number is
 *   deliberately NOT accepted: it used to mean "the single legacy token cost",
 *   and after the switch to characters that meaning no longer exists. Silently
 *   reinterpreting `500` as 500 characters would hide a stale caller.
 */
export function initLedger(options = {}) {
  if (typeof options === "number") {
    throw new TypeError("initLedger no longer accepts a bare number; pass { injectedChars }");
  }
  const injectedChars = Number(options.injectedChars);
  return {
    version: 3,
    injectedChars: Number.isFinite(injectedChars) && injectedChars > 0 ? Math.round(injectedChars) : 0,
    /**
     * `"root"` or `"child"`.
     *
     * Kept as state rather than read from a live header at read time, because the
     * client view and `stats` must agree, and the header is not available to the
     * view function. The child never aggregates its own counts into anything; the
     * PARENT sums children at query time, which is why this flag exists.
     */
    role: options.role === "child" ? "child" : "root",
    /** The child's parent session id, or null. Set so a parent can find it. */
    parentSession: typeof options.parentSession === "string" ? options.parentSession : null,
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
    injectedChars: state.injectedChars,
    role: state.role,
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
