#!/bin/sh
# macOS 开发态：把 `cargo run` 的产物包进一个 adhoc 签名的 dev .app 再执行。
#
# ## 为什么必须包（2026-10-13 实测，macOS 27.0.1 / build 26A434）
#
# 1. `UNUserNotificationCenter.currentNotificationCenter()` 要求进程有 **bundle 身份**。
#    裸 Mach-O（`target/debug/neeko`，`tauri dev` 的默认形态）调用它**直接 abort**：
#    `NSInternalInconsistencyException: bundleProxyForCurrentProcess is nil`（实测 exit 134，
#    且给二进制嵌入带 `CFBundleIdentifier` 的 `__info_plist` 也救不了 —— bundleURL 不是 .app）。
#    因此 `platform/system_notify/macos.rs` 在无 `CFBundleIdentifier` 时只能放弃 UN（返回
#    `None` 回退官方插件）。
# 2. 该回退在 macOS 26+ 是**死路**：`tauri-plugin-notification` 的 macOS 底座是
#    notify-rust → mac-notification-sys → `NSUserNotificationCenter`（Apple 已废弃）。
#    实测调用"成功"、日志零错误、usernoted 收下记录但从不弹横幅 —— 开发态于是只剩应用内通知。
# 3. 让 UN 可用的最小充分条件（逐项实测，**缺一即失败**，失败形态都是
#    `UNErrorDomain Code=1 not allowed`）：.app 目录 + `Info.plist`(CFBundleIdentifier)
#    + **adhoc `codesign`** + **LaunchServices `lsregister` 注册**，
#    且进程可执行文件路径必须在 .app 内（直接 exec 包内二进制即可，**无需** `open`）。
#
# ## 本脚本做什么
#
# 生成 `target/dev-bundle/NeekoDev.app`（identifier / 版本 / 名称从 `tauri.conf.json` 读取，
# 与生产包同 identifier —— 继承系统里已授予的通知授权，不额外弹窗），把刚构建好的二进制
# clonefile 进去、签名、注册，然后 `exec` 它。PID 与 stdio 原样保留，`tauri dev` 的进程控制
# （热重启 / kill）不受影响。
#
# ## 触发方式与边界
#
# `src-tauri/.cargo/config.toml` 的 `[target.'cfg(target_os = "macos")'] runner`。cargo 只在
# **cwd 向上**找配置，所以只有 cwd=src-tauri 的调用命中（`pnpm tauri dev` / `cargo run`）；
# CI 与 `pnpm lint:rust:all-targets` / `pnpm test:rust` 从仓库根带 `--manifest-path` 跑
# （cwd=仓库根）→ 不命中 → 门禁与测试行为零变化。
#
# 非主二进制（`cargo test` 的 `deps/` harness 等）原样放行；任何包装步骤失败都 fail-open
# 回退裸执行（只是会打一条 warn —— 静默降级正是本脚本要消灭的东西）。
set -eu

BIN="$1"
shift

# 相对路径先绝对化（下面要 cd 到别处解析自身位置与 target 根）。
case "$BIN" in
/*) ;;
*) BIN="$PWD/$BIN" ;;
esac

# 只处理 `cargo run` 的主二进制；测试 / 基准 harness（deps/ 下）与其它一律原样执行。
if [ "$(basename "$BIN")" != "neeko" ]; then
  [ "${NEEKO_DEV_BUNDLE_TRACE:-}" = "1" ] && printf '[dev-bundle] passthrough %s\n' "$BIN" >&2
  exec "$BIN" "$@"
fi
case "$BIN" in
*/deps/*)
  [ "${NEEKO_DEV_BUNDLE_TRACE:-}" = "1" ] && printf '[dev-bundle] passthrough harness %s\n' "$BIN" >&2
  exec "$BIN" "$@"
  ;;
esac

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_TAURI="$(dirname "$SELF_DIR")"
CONF="$SRC_TAURI/tauri.conf.json"
TARGET_DIR="$(cd "$(dirname "$BIN")/.." && pwd)"
APP="$TARGET_DIR/dev-bundle/NeekoDev.app"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

warn() { printf '[dev-bundle] %s\n' "$*" >&2; }

# tauri.conf.json 顶层字符串字段（`identifier` / `version` / `productName` 各只出现一次）。
read_conf() {
  sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" "$CONF" | head -1
}

build_bundle() {
  name="$(read_conf productName)"
  ident="$(read_conf identifier)"
  version="$(read_conf version)"
  [ -n "$name" ] || name="Neeko"
  [ -n "$ident" ] || return 1
  [ -n "$version" ] || version="0.0.0"

  mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" || return 1

  cat >"$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleDevelopmentRegion</key>
	<string>en</string>
	<key>CFBundleExecutable</key>
	<string>neeko</string>
	<key>CFBundleIconFile</key>
	<string>icon.icns</string>
	<key>CFBundleIdentifier</key>
	<string>$ident</string>
	<key>CFBundleInfoDictionaryVersion</key>
	<string>6.0</string>
	<key>CFBundleName</key>
	<string>$name</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>$version</string>
	<key>CFBundleVersion</key>
	<string>$version</string>
	<key>LSMinimumSystemVersion</key>
	<string>10.13</string>
	<key>NSHighResolutionCapable</key>
	<true/>
</dict>
</plist>
PLIST

  if [ -f "$SRC_TAURI/icons/icon.icns" ]; then
    cp "$SRC_TAURI/icons/icon.icns" "$APP/Contents/Resources/icon.icns"
  fi

  # 旧进程可能仍持有原 inode：先 unlink 再拷（APFS clonefile，135MB 级拷贝仍是毫秒）。
  rm -f "$APP/Contents/MacOS/neeko"
  cp "$BIN" "$APP/Contents/MacOS/neeko" || return 1

  # 缺签名 / 缺注册都会被 UN 以 `Code=1 not allowed` 拒绝（见头注释第 3 条）。
  # 显式 `|| return 1`：本函数在 if 条件位置执行，`set -e` 对条件不生效，缺了会把
  # 半成品 app 当成功交付。
  codesign --force --sign - "$APP" >/dev/null 2>&1 || return 1
  "$LSREGISTER" -f "$APP" >/dev/null 2>&1 || return 1
}

if command -v codesign >/dev/null 2>&1 && [ -x "$LSREGISTER" ] && build_bundle; then
  if [ "${NEEKO_DEV_BUNDLE_TRACE:-}" = "1" ]; then
    printf '[dev-bundle] exec %s\n' "$APP/Contents/MacOS/neeko" >&2
  fi
  exec "$APP/Contents/MacOS/neeko" "$@"
fi

warn "bundle setup failed — running the bare binary; no system notifications this run (in-app ones are unaffected)"
exec "$BIN" "$@"
