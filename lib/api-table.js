/**
 * Parse the upstream "已暴露类型详细清单" into a queryable API table.
 *
 * Source shape (`entities/api/exposed-types.md`):
 *
 *     ### GameObject
 *     - 暴露率: 50.0%
 *     - 暴露成员: 35
 *     - 完整名称: `Playables.GameObject`
 *     **方法：**
 *     - `T GetComponent[T]()`
 *     - `UnityEngine.Component GetComponent(System.Type)`
 *
 * The file lists what IS exposed. It does not list the 6323 unexposed members
 * (that raw export is not in the repository), so a lookup can only say:
 *   - this member is listed          → exposed
 *   - the type is listed, member not → NOT listed (may still be exposed via a
 *                                      base type or an inherited overload)
 *   - the type is unknown            → no data
 * The tool must report that uncertainty rather than assert non-availability.
 */

/** Split a member line into its return type, name and parameter list. */
export function parseMember(line) {
  // `- \`T GetComponent[T]()\`` → "T GetComponent[T]()"
  const raw = line.replace(/^-\s*`/, "").replace(/`\s*$/, "").trim();
  if (raw.length === 0) return null;

  // Constructors and operators have no return type.
  const call = /^(.*?)\b([A-Za-z_][\w]*)(\[[^\]]*\])?\s*\(([^)]*)\)/.exec(raw);
  if (call === null) {
    // Property or field: `Int32 layer`
    const field = /^(\S+)\s+([A-Za-z_]\w*)$/.exec(raw);
    if (field === null) return { raw, name: null, kind: "unknown" };
    return { raw, name: field[2], returnType: field[1], kind: "field", params: [] };
  }

  const before = call[1].trim();
  return {
    raw,
    name: call[2],
    returnType: before.length === 0 ? null : before,
    generic: call[3] === undefined ? null : call[3].slice(1, -1),
    params: call[4].trim().length === 0 ? [] : call[4].split(",").map((part) => part.trim()),
    kind: "method",
  };
}

/**
 * Parse the whole document into `{ types, members }`.
 * @param text - raw markdown.
 * @returns type records plus a flat member list.
 */
export function parseExposedTypes(text) {
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  const types = [];
  let current = null;

  for (const line of lines) {
    const heading = /^###\s+(.+)$/.exec(line);
    if (heading !== null) {
      current = {
        type: heading[1].trim(),
        fullName: null,
        exposureRate: null,
        memberCount: null,
        members: [],
      };
      types.push(current);
      continue;
    }
    if (current === null) continue;

    const rate = /^-\s*暴露率:\s*([\d.]+)%/.exec(line);
    if (rate !== null) {
      current.exposureRate = Number(rate[1]);
      continue;
    }
    const count = /^-\s*暴露成员:\s*(\d+)/.exec(line);
    if (count !== null) {
      current.memberCount = Number(count[1]);
      continue;
    }
    const fullName = /^-\s*完整名称:\s*`([^`]+)`/.exec(line);
    if (fullName !== null) {
      current.fullName = fullName[1];
      continue;
    }
    if (/^- /.test(line) && line.includes("`")) {
      const member = parseMember(line);
      if (member !== null && member.name !== null) current.members.push(member);
    }
  }

  // Drop sections that carry no member data (e.g. trailing "相关知识").
  const kept = types.filter((type) => type.memberCount !== null || type.members.length > 0);
  return { types: kept };
}

/** Build the flat lookup index the tool queries. */
export function buildIndex(parsed) {
  const byType = new Map();
  const byMember = new Map();

  for (const type of parsed.types) {
    byType.set(type.type.toLowerCase(), type);
    if (type.fullName !== null) {
      const short = type.fullName.split(".").at(-1).toLowerCase();
      if (!byType.has(short)) byType.set(short, type);
    }
    for (const member of type.members) {
      const key = member.name.toLowerCase();
      if (!byMember.has(key)) byMember.set(key, []);
      byMember.get(key).push({ type: type.type, member });
    }
  }

  return { byType, byMember };
}

/**
 * Answer one availability question.
 *
 * THREE OUTCOMES, and the difference between the last two matters:
 *
 *   listed      the member appears under that type → it IS exposed.
 *   not-listed  the type is known but the member is absent → UNKNOWN, not
 *               "unavailable". The source lists only what IS exposed (1253
 *               members); the 6323 unexposed ones have no export in this repo,
 *               and a member can also be reachable through a base type or an
 *               inherited overload that the per-type listing does not repeat.
 *   unknown     the type is not in the document at all → no data either way.
 *
 * The report must carry that uncertainty: telling a caller "unavailable" when
 * the source merely omits it would be a fabricated constraint.
 *
 * @param index - from {@link buildIndex}.
 * @param query - `Type`, `Type.Member`, or a bare `Member`.
 * @returns a verdict record with the evidence behind it.
 */
export function lookup(index, query) {
  const raw = String(query ?? "").trim();
  if (raw.length === 0) return { query: raw, verdict: "unknown", reason: "空查询" };

  // Normalize decorations people paste from code/docs.
  const cleaned = raw
    .replace(/`/g, "")
    .replace(/\(.*\)$/, "")
    .replace(/^UnityEngine\./, "")
    .replace(/^VRC\.SDK3\.Components\./, "")
    .replace(/^VRC\.SDKBase\./, "")
    .trim();

  const dot = cleaned.lastIndexOf(".");
  const explicitType = dot === -1 ? null : cleaned.slice(0, dot).trim();
  const memberName = (dot === -1 ? cleaned : cleaned.slice(dot + 1)).trim();
  const typeKey = explicitType === null ? null : explicitType.split(".").at(-1).toLowerCase();

  // A bare name can be BOTH a type and a member (`transform`, `Object`,
  // `Color`). Report both rather than silently preferring one: the caller knows
  // which it meant, and dropping half the answer would make it re-query.
  if (typeKey === null) {
    const asType = index.byType.get(memberName.toLowerCase());
    const asMember = index.byMember.get(memberName.toLowerCase());
    if (asType !== undefined && asMember !== undefined) {
      return {
        query: raw,
        verdict: "type-and-member",
        type: asType.type,
        fullName: asType.fullName,
        exposureRate: asType.exposureRate,
        memberCount: asType.members.length,
        declaredMemberCount: asType.memberCount,
        members: asType.members.map((member) => member.raw).slice(0, 20),
        overloads: asMember.map((hit) => `${hit.type}.${hit.member.raw}`).slice(0, 20),
        reason:
          `「${memberName}」既是类型名也是成员名。` +
          `作为类型：暴露率 ${asType.exposureRate ?? "未知"}%，本页列出 ${asType.members.length} 个已暴露成员（上游声明 ${asType.memberCount ?? "?"} 个）。` +
          `作为成员：出现在 ${[...new Set(asMember.map((hit) => hit.type))].slice(0, 6).join("、")} 等类型的已暴露成员中。`,
      };
    }
    if (asType !== undefined) {
      return {
        query: raw,
        verdict: "type",
        type: asType.type,
        fullName: asType.fullName,
        exposureRate: asType.exposureRate,
        memberCount: asType.members.length,
        declaredMemberCount: asType.memberCount,
        members: asType.members.map((member) => member.raw).slice(0, 40),
        reason: `该类型在清单中，暴露率 ${asType.exposureRate ?? "未知"}%，本页列出 ${asType.members.length} 个已暴露成员（上游声明 ${asType.memberCount ?? "?"} 个）。`,
      };
    }
  }

  const hits = index.byMember.get(memberName.toLowerCase());
  const scoped = typeKey === null ? hits : hits?.filter((hit) => hit.type.toLowerCase() === typeKey);

  if (scoped !== undefined && scoped.length > 0) {
    return {
      query: raw,
      verdict: "exposed",
      type: scoped[0].type,
      overloads: scoped.map((hit) => hit.member.raw),
      reason: `在「${scoped[0].type}」的已暴露成员中命中。`,
    };
  }

  if (typeKey !== null) {
    const type = index.byType.get(typeKey);
    if (type === undefined) {
      return {
        query: raw,
        verdict: "unknown",
        reason: `清单中没有「${explicitType}」这个类型，因此无法判断其成员。`,
      };
    }
    return {
      query: raw,
      verdict: "not-listed",
      type: type.type,
      fullName: type.fullName,
      exposureRate: type.exposureRate,
      siblingMembers: type.members.map((member) => member.name).filter((name, i, all) => all.indexOf(name) === i).slice(0, 20),
      reason:
        `「${type.type}」在清单中（暴露率 ${type.exposureRate ?? "未知"}%），但其中没有「${memberName}」。` +
        "这不等于不可用：本清单只收录已暴露成员，未暴露的成员没有导出数据，且基类/继承重载可能在此未重复列出。",
    };
  }

  return {
    query: raw,
    verdict: "unknown",
    reason: `清单中既没有名为「${memberName}」的类型，也没有同名成员。`,
  };
}
