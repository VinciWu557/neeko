"""`assetProtocol.scope` 必须显式允许点开头的路径段（`requireLiteralLeadingDot: false`）。

背景（2026-10-29 事故）：图片预览（`ImageFileView` / markdown 图片）稳定报
“Image failed to load”，排查方向先被误判成 worktree 路径基准。真实原因在 Tauri 自身：

- `assetProtocol.scope: ["**"]` 是 `FsScope` 的**简写数组**形态；
- 简写形态没有 `require_literal_leading_dot` 字段，Tauri 在 **Unix（macOS/Linux）默认取
  `true`**（源码 `tauri/src/scope/fs.rs`：`// dotfiles are not supposed to be exposed by
  default on unix`）；
- `require_literal_leading_dot = true` 时，glob 的 `**` 匹配到「点开头的路径段」立即判不匹配
  （`glob` crate：`follows_separator && require_literal_leading_dot && c == '.'` → 失败）。

于是 `docs/.img/project-struct.png` 这类路径被 scope 拒绝，asset 协议返回 **403**，
`<img>` 触发 `onError` —— 表现为「图片加载失败」，且控制台只有一条 asset 协议日志。
`.img` / `.github` / `.config` 这类点目录在文档站里非常常见，命中率不低。

判据：`tauri.conf.json` 的 `app.security.assetProtocol.scope` 必须是**对象形态**且
`requireLiteralLeadingDot`（或 kebab 别名 `require-literal-leading-dot`）显式为 `false`。
简写数组形态一律判违规 —— 它在 Unix 上是「碰运气」的配置：不含点段的路径能用，
含点段的路径静默 403。

注意本护栏**不收紧** scope（`**` → 白名单属单独立项的加固项），只钉住 dotfile 语义。
"""
from __future__ import annotations

import json

from guards.core.contract import Context, Finding, Guard, GuardResult

CONF = "src-tauri/tauri.conf.json"

DOT_KEY_CAMEL = "requireLiteralLeadingDot"
DOT_KEY_KEBAB = "require-literal-leading-dot"

GUARD = Guard(
    id="check_asset_protocol_dotfiles",
    title="assetProtocol scope 必须允许点开头的路径段（否则点目录里的图片静默 403）",
    scopes=(CONF,),
    docs=".trellis/spec/frontend/api-layer.md",
    fix_hint=(
        '把 scope 写成对象形态：{"allow": ["**"], "requireLiteralLeadingDot": false}；'
        "不要用简写数组（Unix 上默认禁止点开头路径段）"
    ),
)


def check(ctx: Context) -> GuardResult:
    conf_path = ctx.path(CONF)
    if not conf_path.is_file():
        return GuardResult.broken(f"找不到 {CONF}")

    try:
        conf = json.loads(conf_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        return GuardResult.broken(f"{CONF} 不是合法 JSON：{e}")

    security = (conf.get("app") or {}).get("security") or {}
    asset = security.get("assetProtocol") or {}
    if not asset.get("enable"):
        # 未启用 asset 协议：本地图片走别的通道，本护栏不适用。
        return GuardResult.passed(1, metrics="asset 协议未启用（不适用）")

    scope = asset.get("scope")
    if isinstance(scope, list):
        return GuardResult.violated(
            1,
            [
                Finding(
                    f"scope 是简写数组形态（{[str(s) for s in scope[:3]]}）："
                    "Unix 上 require_literal_leading_dot 默认为 true，"
                    "点开头路径段（如 docs/.img/*.png）的 asset 请求会被拒绝（403）",
                    CONF,
                )
            ],
            metrics="简写数组形态",
        )

    if not isinstance(scope, dict):
        return GuardResult.violated(
            1,
            [Finding(f"scope 形态无法识别：{type(scope).__name__}", CONF)],
            metrics="无法识别",
        )

    dot = scope.get(DOT_KEY_CAMEL, scope.get(DOT_KEY_KEBAB))
    if dot is not False:
        return GuardResult.violated(
            1,
            [
                Finding(
                    "scope 对象缺少显式的 requireLiteralLeadingDot: false"
                    f"（当前值 {dot!r}）—— Unix 默认 true 会让点目录里的图片静默 403",
                    CONF,
                )
            ],
            metrics=f"requireLiteralLeadingDot={dot!r}",
        )

    allowed = scope.get("allow") or []
    if not allowed:
        return GuardResult.violated(
            1,
            [Finding("scope.allow 为空 —— asset 协议将拒绝一切路径", CONF)],
            metrics="allow 为空",
        )

    return GuardResult.passed(
        1, metrics=f"allow={len(allowed)} 条 / requireLiteralLeadingDot=false"
    )
