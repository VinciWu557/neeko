#!/bin/sh
# 给 macOS bundle 签上**稳定的自签名身份**（2026-10-16 复盘新增）。
#
# ## 为什么需要这个脚本
#
# `UNUserNotificationCenter` 的授权记录按 `bundleIdentifier` 归集、却校验**代码签名身份**。
# adhoc (`codesign -s -`) 不写证书，身份随内容派生 —— 每台机器、每次构建都是新身份。
# 当 `com.neeko.desktop` 被多个不同身份的二进制交替登记时，此前授予的授权会作废并被系统
# 标记 `denied`，且**此后连授权弹窗都不再弹**。实测形态：
# 「系统通知昨天还好的，今天再也收不到」，而 `~/.neeko/neeko.log` 里只有一行
# `[notify] macOS: UN authorization not granted (… UNErrorDomain error 1.)`。
#
# 修复 = 一张自签名代码签名证书（免费，无需 Apple Developer 账号）：
#   钥匙串访问 → 菜单栏「显示」→「证书助理」→「创建证书…」
#   名称 = 身份名（定下来别改）· 自签名根证书 · 代码签名 · 勾「默认值」
# 之后**每次构建产物都用同一个身份签**，系统才会把它当成同一个应用、共享同一份授权。
#
# ## 为什么签名不写在 tauri.conf.json
#
# Tauri 的 `bundle.macOS.signingIdentity` 只接受字面字符串（不支持环境变量展开）。
# 写死身份名会让所有没建这张证书的机器（CI runner、新克隆的开发机）在 `pnpm tauri build`
# 直接失败。故 conf 里保持 `null`（不签名），签名统一走本脚本、按需显式执行。
#
# ## 用法
#
#   NEEKO_CODESIGN_IDENTITY="Neeko Development" scripts/macos-sign.sh [APP路径]
#
# - APP 缺省 `src-tauri/target/release/bundle/macos/Neeko.app`；
# - 环境变量未设置 → 打印说明后退出 1（**不**静默 adhoc：静默正是本脚本要消灭的故障形态）；
# - 身份名在钥匙串里找不到 → 退出 1 并给出 `security find-identity` 的诊断命令。

set -eu

IDENTITY="${NEEKO_CODESIGN_IDENTITY:-}"
APP="${1:-}"

die() { printf 'macos-sign: %s\n' "$*" >&2; exit 1; }

[ -n "$IDENTITY" ] || die "NEEKO_CODESIGN_IDENTITY 未设置。

  先用一张自签名代码签名证书（一次性，免费）：
    钥匙串访问 → 菜单栏「显示」→「证书助理」→「创建证书…」
      名称 = 你想用的身份名 · 自签名根证书 · 代码签名 · 勾选「默认值」
    然后双击证书 →「信任」→「使用此证书时」= 始终信任

  确认身份已被 codesign 识别：
    security find-identity -v -p codesigning

  再带上身份名重跑：
    NEEKO_CODESIGN_IDENTITY=\"<身份名>\" $0 <app路径>"

# APP 缺省自动发现 `target/release/bundle/macos/*.app`：
# - 不硬编码应用名 —— 名字由 productName 决定，改了就该自动跟上；
# - 历史上 macos/ 下可能残留多个 .app（本地反复构建不同版本），取**最新修改**的那个，
#   也就是本次 `pnpm tauri build` 的产物，而不是签到一个旧包上。
if [ -z "$APP" ]; then
  APP="$(ls -dt src-tauri/target/release/bundle/macos/*.app 2>/dev/null | head -1 || true)"
fi

[ -n "$APP" ] || die "在 src-tauri/target/release/bundle/macos/ 下找不到 .app。

  先执行 pnpm tauri build 生成产物，或把 app 路径作为第一个参数传入：
    $0 /path/to/Neeko.app"

[ -d "$APP" ] || die "不是一个 app 目录：$APP"

# Info.plist 是 bundle 的判据（codesign 自己的 "bundle format unrecognized" 太晦）；
# 缺了它说明传错路径，先在这里拦住，别让用户对着一句 codesign 术语猜。
[ -f "$APP/Contents/Info.plist" ] || die "$APP 不是 macOS app bundle（缺少 Contents/Info.plist）"

# 身份必须真实存在于钥匙串：找不到时明确报错，而不是让 codesign 抛一句难懂的
# "no identity found"。列出现有身份，让调用方能立刻比对拼写。
if ! security find-identity -v -p codesigning 2>/dev/null | grep -qF "\"$IDENTITY\""; then
  printf 'macos-sign: 钥匙串里没有身份 "%s"。现有身份：\n' "$IDENTITY" >&2
  security find-identity -v -p codesigning >&2 || true
  exit 1
fi

# --force：替换既有签名（adhoc 或旧证书）；--deep：覆盖包内 frameworks / helper，
# 否则外层签名有效而内层仍是旧身份，系统仍会看到混合身份。
codesign --force --deep --sign "$IDENTITY" "$APP"

# 重新注册：LaunchServices 的缓存决定「com.neeko.desktop 对应哪个身份」，
# 不刷新的话旧身份记录可能继续被系统采用。
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
if [ -x "$LSREGISTER" ]; then
  "$LSREGISTER" -f "$APP" || true
fi

# 收尾校验：签名必须自证有效，否则前面任何一步静默失败都会留下「以为签好了」的假象。
codesign --verify --deep --strict "$APP"
printf 'macos-sign: signed %s as "%s"\n' "$APP" "$IDENTITY"
