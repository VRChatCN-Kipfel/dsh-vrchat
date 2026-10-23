/**
 * Prove number-provenance-check FAILS on a drifted number.
 *
 * A guard that has never been observed failing is not evidence. This one is
 * especially prone to silent death: it matches over a 414-page corpus, so an
 * early `return`, a wrong corpus path, or an over-broad exemption list would make
 * it print "全部通过" while checking nothing at all.
 *
 * The real persona is never modified: each case stages a temp copy.
 *
 * Usage: node tools/number-provenance-selftest.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const GUARD = path.join(__dirname, "number-provenance-check.cjs");

const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok, detail });

const baseline = spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: "utf8" });
check("未改动时通过", baseline.status === 0, (baseline.stdout ?? "").trim().split("\n").at(-1));

/**
 * Stage a mutated persona in a temp tree and run the guard there.
 *
 * Returns the guard's output and exit status WITHOUT asserting anything: the same
 * helper serves both "expect failure" (drift caught) and "expect success" (a known
 * limit), and a helper that asserts its own expectation cannot express the second.
 *
 * The corpus is symlinked rather than copied: 414 files and 4 MB per case is not
 * worth staging, and the guard resolves the same relative path either way.
 */
function runWith(label, mutate) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "numprov-"));
  fs.mkdirSync(path.join(temp, "content-src"), { recursive: true });
  fs.mkdirSync(path.join(temp, "tools"), { recursive: true });

  for (const rel of [
    "content-src/persona-prefix.md",
    "content-src/t0-core.md",
    "content-src/t1-world.md",
    "content-src/t1-avatar.md",
    "content-src/t1-shader.md",
    "content-src/domain-map.md",
  ]) {
    const src = path.join(ROOT, rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(temp, rel));
  }
  const target = path.join(temp, "content-src", "persona-prefix.md");
  fs.writeFileSync(target, mutate(fs.readFileSync(target, "utf8")), "utf8");

  fs.symlinkSync(
    path.join(ROOT, "VRChat-Agent-Creator-Library"),
    path.join(temp, "VRChat-Agent-Creator-Library"),
    "junction",
  );
  fs.copyFileSync(GUARD, path.join(temp, "tools", "number-provenance-check.cjs"));

  const run = spawnSync(process.execPath, [path.join(temp, "tools", "number-provenance-check.cjs")], {
    cwd: temp,
    encoding: "utf8",
  });
  fs.rmSync(temp, { recursive: true, force: true });
  return { label, status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
}

/** Expect the guard to REJECT the mutation. */
function runBroken(label, mutate) {
  const result = runWith(label, mutate);
  check(label, result.status !== 0, (result.output.trim().split("\n").at(-1) ?? "").slice(0, 100));
  return result.output;
}

const drift = runBroken("数字漂移（20,000 → 23,000）会被发现", (text) => text.replace("20,000", "23,000"));
check("失败信息指出是哪个数字", /23000/.test(drift), drift.split("\n").find((line) => line.includes("23000")) ?? "");

runBroken("带宽漂移（11 KB/s → 15 KB/s）会被发现", (text) => text.replace("11 KB/s", "15 KB/s"));
runBroken("Unity 绑定写错会被发现", (text) => text.replace("2022.3.22f1", "2021.3.22f1"));

/**
 * KNOWN LIMIT, asserted as such rather than papered over.
 *
 * `128 bits` IS in the corpus — `expression-menu.md:434` says "256 bits（约 128 bits
 * 老 SDK）". So changing the persona's 256-bit budget to 128 bits PASSES this guard.
 * The guard checks that a number exists under the same topic word; it does not read
 * the qualifying clause around it ("老 SDK"), and teaching it to would mean encoding
 * judgement about corpus prose rather than checking a binding.
 *
 * This is recorded as a limit so nobody reads a green run as "every number is right".
 */
const knownGap = runWith("已知边界：256→128 bits 不会被发现", (text) => text.replace("256 bits", "128 bits"));
check(
  "该边界仍存在（守卫没有被悄悄放宽成什么都拦，也没有变强到能拦它）",
  knownGap.status === 0,
  "此条若失败，说明守卫现在能抓住 128 bits 了 —— 那就该把它改成正向断言",
);

fs.rmSync(path.join(__dirname, "..", "..", ".numprov-tmp"), { recursive: true, force: true });

let failed = 0;
for (const item of checks) {
  if (!item.ok) failed++;
  console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `\n      ${item.detail}` : ""}`);
}
console.log("");
console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
if (failed > 0) process.exitCode = 1;
