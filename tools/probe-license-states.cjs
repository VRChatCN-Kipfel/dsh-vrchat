/**
 * Exercise the license branches the machine itself cannot currently produce.
 *
 * The real license is 3 days from expiry, so only `expiring` is observable here.
 * `expired` is the state that actually matters — it silently breaks Unity while
 * pointing at the project — and it must be proven to render, not assumed.
 *
 * Usage: node tools/probe-license-states.cjs
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

async function main() {
  const mod = await import(pathToFileURL(path.join(__dirname, "..", "lib", "unity-status.js")).href);

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "license-states-"));
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  /**
   * Render one state through the whole path: a temp ProgramData that contains a
   * crafted .ulf, the same reader the tool uses, then the report.
   */
  const render = (label, body, now) => {
    const dir = path.join(temp, label);
    fs.mkdirSync(path.join(dir, "Unity"), { recursive: true });
    const file = path.join(dir, "Unity", "Unity_lic.ulf");
    if (body !== null) fs.writeFileSync(file, body, "utf8");

    const license = mod.inspectLicense({
      programData: dir,
      now: now ?? Date.now(),
      exists: (p) => fs.existsSync(p),
      readText: (p) => {
        try {
          return fs.readFileSync(p, "utf8");
        } catch {
          return null;
        }
      },
    });

    return {
      license,
      text: mod.renderReport({ processes: [], projects: [], commandEvidence: [], cliDetected: false, license }),
    };
  };

  const ulf = (stop) => `<?xml version="1.0"?><Root><License Version="1"><StopDate Value="${stop}" /></License></Root>`;
  const at = (y, m, d, h = 0) =>
    `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00`;
  const localNow = (y, m, d, h = 12) => new Date(y, m - 1, d, h, 0, 0).getTime();

  // ── expired ────────────────────────────────────────────────────────────
  const expired = render("expired", ulf(at(2026, 9, 1)), localNow(2026, 10, 22));
  check("过期状态被识别", expired.license.state === "expired", expired.license.state);
  check("过期时报告写明已过期", /已过期/.test(expired.text));
  check("过期时指出会打不开项目", /打不开项目/.test(expired.text));
  check("过期时给出续期路径", /Unity Hub.*许可证/.test(expired.text));
  check("过期时提示先续期再排查", /先续期再排查/.test(expired.text));

  // ── expiring ───────────────────────────────────────────────────────────
  const expiring = render("expiring", ulf(at(2026, 10, 25)), localNow(2026, 10, 22));
  check("临近到期被识别", expiring.license.state === "expiring", expiring.license.state);
  check("临近到期给出天数", /天后到期/.test(expiring.text));
  check("临近到期提示提前续期", /提前续期/.test(expiring.text));

  // ── active ─────────────────────────────────────────────────────────────
  const active = render("active", ulf(at(2027, 6, 1)), localNow(2026, 10, 22));
  check("有效期内被识别", active.license.state === "active", active.license.state);
  check("有效期内报到期日", /有效至 2027-06-01/.test(active.text), active.text.split("\n").find((l) => l.includes("许可证")));

  // ── perpetual ──────────────────────────────────────────────────────────
  const perpetual = render("perpetual", '<?xml version="1.0"?><Root><License Version="1"/></Root>', localNow(2026, 10, 22));
  check("无到期日视为永久", perpetual.license.state === "perpetual", perpetual.license.state);
  check("永久时报告不提及期", /无到期日/.test(perpetual.text));

  // ── missing ────────────────────────────────────────────────────────────
  const missing = render("missing", null, localNow(2026, 10, 22));
  check("无文件为 missing", missing.license.state === "missing", missing.license.state);
  check("缺失时不声称未激活", !/未激活|没有激活/.test(missing.text));
  check("缺失时说明可能是激活方式不同", /不等于没激活/.test(missing.text));

  // ── key material must never surface, in any state ─────────────────────
  const withKey = render(
    "secret",
    `<?xml version="1.0"?><Root><License Version="1"><StopDate Value="${at(2027, 1, 1)}" />` +
      '<LicenseKey Value="FAKE-KEY-SHOULD-NEVER-APPEAR-0123456789" /></License></Root>',
    localNow(2026, 10, 22),
  );
  check("任何状态下报告都不含密钥", !/FAKE-KEY-SHOULD-NEVER-APPEAR|LicenseKey/.test(withKey.text));
  check("任何状态下报告都不含 XML", !/<\?xml|<License/.test(withKey.text));

  fs.rmSync(temp, { recursive: true, force: true });

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
