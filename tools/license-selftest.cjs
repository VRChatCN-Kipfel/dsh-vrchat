/**
 * Offline self-test for Unity license inspection.
 *
 * An expired license is one of the most common ways a VRChat creator gets stuck,
 * and its symptoms point at the project rather than at licensing. The state machine
 * is therefore tested against a fixed clock, not the machine's own license — the
 * real file changes over time and would make this flaky.
 *
 * Usage: node tools/license-selftest.cjs
 */
const path = require("node:path");
const { pathToFileURL } = require("node:url");

/** Build a minimal `.ulf` body carrying only the fields the tool reads. */
const ulf = (stopDate) =>
  `<?xml version="1.0"?>\n<Root>\n<License Version="1">\n<StopDate Value="${stopDate}" />\n</License>\n</Root>`;

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "unity-status.js")).href);

  // Unity writes timestamps WITHOUT a timezone suffix (`2026-10-26T07:39:01`),
  // which `Date.parse` correctly reads as LOCAL time. The fixed clock must
  // therefore be built the same way, or the day arithmetic is off by the zone
  // offset (8h here) and the boundary cases flip.
  const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime(); // local 2026-10-22 12:00

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  /** Local-time timestamp helper, matching how the file expresses dates. */
  const at = (year, month, day, hours = 0, minutes = 0, seconds = 0) =>
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T` +
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

  /** Run inspectLicense over an in-memory filesystem. */
  const inspect = (files) =>
    mod.inspectLicense({
      programData: "C:\\ProgramData",
      now: NOW,
      exists: (p) => Object.hasOwn(files, p),
      readText: (p) => (Object.hasOwn(files, p) ? files[p] : null),
    });

  const FILE = "C:\\ProgramData\\Unity\\Unity_lic.ulf";

  // ── state machine against a fixed clock ────────────────────────────────
  check(
    "有效期内为 active",
    inspect({ [FILE]: ulf(at(2027, 1, 1)) }).state === "active",
    inspect({ [FILE]: ulf(at(2027, 1, 1)) }).state,
  );
  check(
    "一个月后到期仍在 active",
    inspect({ [FILE]: ulf(at(2026, 11, 22)) }).state === "active",
  );
  check(
    "6 天后到期转为 expiring",
    inspect({ [FILE]: ulf(at(2026, 10, 28, 12)) }).state === "expiring",
    inspect({ [FILE]: ulf(at(2026, 10, 28, 12)) }).state,
  );
  check(
    "已过期为 expired",
    inspect({ [FILE]: ulf(at(2026, 10, 1)) }).state === "expired",
  );
  check("缺失文件为 missing", inspect({}).state === "missing");
  check(
    "无 StopDate 视为永久",
    inspect({ [FILE]: '<?xml version="1.0"?><Root><License Version="1"/></Root>' }).state === "perpetual",
  );
  check(
    "StopDate 无法解析时退化为永久而非崩溃",
    inspect({ [FILE]: ulf("not-a-date") }).state === "perpetual",
  );

  // ── the numbers the report shows ───────────────────────────────────────
  const expiring = inspect({ [FILE]: ulf(at(2026, 10, 26, 7, 39, 1)) });
  check("expiring 带剩余天数", typeof expiring.daysLeft === "number" && expiring.daysLeft > 0, String(expiring.daysLeft));
  check("expiring 带到期日期", typeof expiring.stopDate === "string", String(expiring.stopDate));
  check("expired 的剩余天数为负", inspect({ [FILE]: ulf(at(2026, 10, 1)) }).daysLeft < 0);

  // ── seven-day warning boundary is deliberate, not incidental ───────────
  const justInside = inspect({ [FILE]: ulf(at(2026, 10, 29, 11)) }); // ~6.96 days
  check("临界内 (<7 天) 为 expiring", justInside.state === "expiring", String(justInside.daysLeft));
  const justOutside = inspect({ [FILE]: ulf(at(2026, 10, 29, 13)) }); // ~7.04 days
  check("临界外 (>=7 天) 为 active", justOutside.state === "active", String(justOutside.daysLeft));

  // ── report rendering per state ─────────────────────────────────────────
  const renderFor = (license) =>
    mod.renderReport({ processes: [], projects: [], commandEvidence: [], cliDetected: false, license });

  const expiredText = renderFor(inspect({ [FILE]: ulf(at(2026, 10, 1)) }));
  check("过期时报告明说已过期", /已过期/.test(expiredText));
  check("过期时指出后果", /打不开项目|构建失败/.test(expiredText));
  check("过期时给出续期路径", /Unity Hub.*许可证.*激活|许可证/.test(expiredText));

  const expiringText = renderFor(expiring);
  check("临近到期时报告提示天数", /天后到期/.test(expiringText), expiringText.split("\n").find((l) => l.includes("许可证")));
  check("临近到期时提示提前续期", /提前续期/.test(expiringText));

  const missingText = renderFor(inspect({}));
  check("缺失时不明说「没激活」", !/未激活|没有激活/.test(missingText));
  check("缺失时说明可能是激活方式不同", /不等于没激活/.test(missingText));

  // ── the license file must never be echoed ─────────────────────────────
  const secret = ulf(at(2027, 1, 1)).replace(
    "</License>",
    '<LicenseKey Value="THIS-IS-A-FAKE-KEY-DO-NOT-ECHO-0123456789" /></License>',
  );
  const secretText = renderFor(inspect({ [FILE]: secret }));
  check("报告不含许可密钥", !/THIS-IS-A-FAKE-KEY|LicenseKey/.test(secretText));
  check("报告不含 XML 原文", !/<\?xml|<License/.test(secretText));
  check("报告只含日期", /2027-01-01/.test(secretText), secretText.split("\n").find((l) => l.includes("许可证")));

  // ── no license field at all must not break the report ─────────────────
  const withoutLicense = mod.renderReport({
    processes: [],
    projects: [],
    commandEvidence: [],
    cliDetected: false,
  });
  check("未传 license 时不渲染该段", !/Unity 许可证/.test(withoutLicense));
  check("未传 license 时报告仍完整", /没有找到确凿的 MCP 证据/.test(withoutLicense));

  let failed = 0;
  for (const item of checks) {
    if (!item.ok) failed++;
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? `  (${item.detail})` : ""}`);
  }
  console.log("");
  console.log(failed === 0 ? `全部 ${checks.length} 条通过` : `${failed} / ${checks.length} 条未通过`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
