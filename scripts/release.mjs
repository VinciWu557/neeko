import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function run(cmd, ignoreError = false) {
  console.log(`> ${cmd}`);
  try {
    execSync(cmd, { cwd: ROOT, stdio: "inherit" });
  } catch (e) {
    if (!ignoreError) throw e;
  }
}

function exit(msg) {
  console.error(`\n❌ ${msg}`);
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) {
  exit("Usage: pnpm release <version>\n  e.g. pnpm release 1.0.4");
}

const version = raw.replace(/^v/, "");
if (!/^\d+\.\d+\.\d+/.test(version)) {
  exit(`Invalid version: ${version}`);
}

const tag = `v${version}`;
console.log(`\nReleasing ${tag}\n`);

try {
  // Update tauri.conf.json
  const tauriConfPath = resolve(ROOT, "src-tauri/tauri.conf.json");
  const tauriConf = readFileSync(tauriConfPath, "utf-8");
  writeFileSync(
    tauriConfPath,
    tauriConf.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`),
  );
  console.log(`✓ Updated src-tauri/tauri.conf.json → ${version}`);

  // Update Cargo.toml (first `version = "..."` line only)
  const cargoPath = resolve(ROOT, "src-tauri/Cargo.toml");
  const cargo = readFileSync(cargoPath, "utf-8");
  let replaced = false;
  const cargoUpdated = cargo.replace(/^version\s*=\s*"[^"]*"/m, (match) => {
    if (!replaced) {
      replaced = true;
      return `version = "${version}"`;
    }
    return match;
  });
  writeFileSync(cargoPath, cargoUpdated);
  console.log(`✓ Updated src-tauri/Cargo.toml → ${version}`);

  // Update package.json
  const pkgPath = resolve(ROOT, "package.json");
  const pkg = readFileSync(pkgPath, "utf-8");
  writeFileSync(
    pkgPath,
    pkg.replace(/"version":\s*"[^"]*"/, `"version": "${version}"`),
  );
  console.log(`✓ Updated package.json → ${version}`);

  // Generate CHANGELOG.md via git-cliff
  try {
    execSync("git-cliff --version", { cwd: ROOT, stdio: "ignore" });
  } catch {
    console.log("⚠ git-cliff not found, installing...");
    run("cargo install git-cliff");
  }
  run(`git-cliff --output CHANGELOG.md --tag ${tag}`);
  console.log("✓ Generated CHANGELOG.md");

  // macOS bundle 签名（可选步骤，仅本地有证书时执行）。
  //
  // 为什么不在 tauri.conf.json 里写死身份：Tauri 的 signingIdentity 只接受字面字符串，
  // 写死会让没有该证书的机器（CI / 新开发机）在 tauri build 直接失败。故统一在这里
  // 按环境变量决定 —— 未设置就跳过（发布流程不因缺证书而中断），设置了才签。
  // 签名的必要性见 scripts/macos-sign.sh 头注释（UN 授权按 bundle id 归集但校验代码身份，
  // 身份漂移会让系统通知静默失效且不再弹授权框）。
  if (process.platform === "darwin") {
    if (process.env.NEEKO_CODESIGN_IDENTITY) {
      try {
        run("scripts/macos-sign.sh");
        console.log("✓ Signed macOS bundle");
      } catch {
        // 签名失败不阻断发布：产物未签名仍可本地运行，只是系统通知会受身份漂移影响。
        // 明确 warn 而非静默跳过 —— 静默正是本环节要消灭的故障形态。
        console.warn(
          "⚠ macOS 签名失败（NEEKO_CODESIGN_IDENTITY 已设置但签名未成功）；" +
            "产物未签名，系统通知可能因身份漂移失效。详见 scripts/macos-sign.sh",
        );
      }
    } else {
      console.log(
        "⚠ 跳过 macOS 签名：未设置 NEEKO_CODESIGN_IDENTITY。" +
          "需要系统通知稳定时请先建自签名证书（见 scripts/macos-sign.sh 头注释）",
      );
    }
  }

  // Git commit + tag
  run("git add .");
  run(`git commit -m "chore: release ${tag}"`);
  run(`git tag ${tag}`);

  console.log(`\n✅ Released ${tag}`);
  console.log(`\nNext steps:`);
  console.log(`  git push && git push --tags`);
} catch (e) {
  console.error(`\n❌ Release failed: ${e.message || e}`);
  console.error(`\nNo changes were committed.`);
  process.exit(1);
}
