/**
 * Prove skill-validate.cjs actually rejects malformed skills.
 *
 * A validator nobody has watched fail is not evidence. Each case breaks exactly
 * one rule the Host enforces, so a passing run means the checks are live.
 *
 * Usage: node tools/skill-validate-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const VALIDATOR = path.join(__dirname, "skill-validate.cjs");

/** A minimal skill that passes every rule. `name` must equal the directory name. */
const goodFor = (dirName) => `---
name: ${dirName}
description: Use when testing the validator itself; this description is long enough to route on and says when to use it.
---

# Sample

Body text long enough to clear the minimum length check. 它是占位内容，只用于校验器自测。
这里再补一句，确保正文超过一百字符，避免把长度门槛本身当成校验器的缺陷。
最后一句话用来把长度稳定地推过阈值。`.trim();

async function main() {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "skill-validate-"));

  /** Write one skill dir and run the validator against it. */
  const run = (dirName, content) => {
    const dir = path.join(temp, dirName);
    fs.mkdirSync(dir, { recursive: true });
    if (content !== null) fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf8");
    const result = spawnSync(process.execPath, [VALIDATOR, dir], { cwd: ROOT, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  };

  // ── baseline ───────────────────────────────────────────────────────────
  const good = run("sample-skill", goodFor("sample-skill"));
  check("合法技能通过", good.status === 0, good.output.trim().split("\n").at(-1));

  // ── CRLF must not be mistaken for "no frontmatter" ─────────────────────
  //
  // The upstream skills are checked out with CRLF, so reading disk verbatim makes
  // a valid file look broken. This exact false negative happened on all three
  // upstream skills before the reader was normalized.
  const crlf = run("crlf-skill", goodFor("crlf-skill").replace(/\n/g, "\r\n"));
  check("CRLF 行尾的技能仍通过", crlf.status === 0, crlf.output.trim().split("\n").at(-1));
  check("CRLF 不被误报为缺 frontmatter", !/有 frontmatter/.test(crlf.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n")));

  // ── each break targets one rule ────────────────────────────────────────
  const cases = [
    {
      label: "缺 SKILL.md",
      dir: "no-file",
      content: null,
      expect: /含 SKILL\.md/,
    },
    {
      label: "无 frontmatter",
      dir: "no-frontmatter",
      content: "# 只有正文\n\n没有 frontmatter。 ".repeat(20),
      expect: /有 frontmatter/,
    },
    {
      label: "name 不合法（大写）",
      dir: "bad-name",
      content: goodFor("bad-name").replace("name: bad-name", "name: Sample_Skill"),
      expect: /name 合法/,
    },
    {
      label: "description 过短",
      dir: "short-desc",
      content: goodFor("short-desc").replace(/^description:.*$/m, "description: too short"),
      expect: /description 长度适合路由/,
    },
    {
      label: "正文过短",
      dir: "short-body",
      content: "---\nname: short-body\ndescription: Use when testing; this description is long enough to pass the routing length gate.\n---\n\n# T\n\nx\n",
      expect: /正文非空/,
    },
    {
      label: "正文无标题",
      dir: "no-heading",
      content:
        "---\nname: no-heading\ndescription: Use when testing; this description is long enough to pass the routing length gate.\n---\n\n" +
        "这里没有一级标题，但正文足够长，应当只触发标题这一条失败。 ".repeat(4),
      expect: /正文有标题/,
    },
  ];

  for (const c of cases) {
    const result = run(c.dir, c.content);
    check(`${c.label} 时校验失败`, result.status !== 0, `exit=${result.status}`);
    check(`${c.label} 的报告点名问题`, c.expect.test(result.output), result.output.split("\n").find((l) => l.startsWith("FAIL")) ?? "");
  }

  // ── a name that differs from the directory must PASS ───────────────────
  //
  // The Host keeps the directory as a locator, not as identity: `parseSkillFile`
  // validates only the name format and a non-empty description. A repository
  // registered as one skill therefore legitimately has a different directory
  // name — this validator once treated that as an error and rejected the real
  // "repo as skill" layout.
  const mismatched = run("some-dir-name", goodFor("x").replace("name: x", "name: different-name"));
  check("name 与目录名不同时仍然通过", mismatched.status === 0, mismatched.output.trim().split("\n").at(-1));
  check("但会给出提示", /NOTE/.test(mismatched.output), "提示而非失败");

  fs.rmSync(temp, { recursive: true, force: true });

  // The real skill must still pass, so a broken validator cannot hide behind it.
  const real = spawnSync(
    process.execPath,
    [VALIDATOR, path.join(ROOT, "vendor", "vrchat-world-codex-skills")],
    { cwd: ROOT, encoding: "utf8" },
  );
  check("真实技能仍然通过", real.status === 0, (real.stdout ?? "").trim().split("\n").at(-1));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
