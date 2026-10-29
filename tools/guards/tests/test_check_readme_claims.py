"""README 事实护栏用例。

夹具原则：每个用例只破坏**一个**判据，并断言该判据真的红 —— 否则「5 条判据」里
哪条失效都看不出来（本仓库被假绿坑过多次，见 quality-guidelines §18）。
"""
from __future__ import annotations

import unittest

from guards.checks import check_readme_claims as subject
from guards.core.contract import ERROR, PASS, VIOLATION
from guards.tests.support import context, make_repo, temp_repo

THEMES = ["dark", "light", "one-dark-pro", "claude", "classic-dark"]
CLI_IDS = [i for i in subject.CLI_AGENT_NAMES]


def readme_en(**overrides) -> str:
    parts = {
        "node": "24+",
        "pnpm": "11+",
        "agents": "**, ".join(subject.CLI_AGENT_NAMES.values()) + "**",
        "agent_count": "10",
        "themes": "5",
        "extra": "",
        "table": "",
        "image": "docs/.img/capability-map.svg",
    }
    parts.update(overrides)
    return f"""# Neeko

## Preview

![capability map]({parts["image"]})

## Install

- [Node.js](https://nodejs.org/) {parts["node"]}
- [pnpm](https://pnpm.io/) {parts["pnpm"]}
- [Rust](https://rustup.rs/) — pinned in rust-toolchain.toml

## Features

### Terminal & Agents

- **{parts["agent_count"]} built-in CLI agents** — {parts["agents"]}
- **Custom agents** — add your own CLI

A built-in MockAgent lets you try chat without installing any CLI.
{parts["table"]}{parts["extra"]}
## Reference

- **Keyboard shortcuts** — [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md)
- **Themes** — {parts["themes"]} built-in themes (Dark, Light, One Dark Pro, Claude, Classic Dark)
"""


def readme_cn(**overrides) -> str:
    parts = {
        "node": "24+",
        "pnpm": "11+",
        "agents": "、".join(subject.CLI_AGENT_NAMES.values()),
        "agent_count": "10",
        "themes": "5",
        "extra": "",
        "table": "",
        "image": "docs/.img/capability-map.svg",
    }
    parts.update(overrides)
    return f"""# Neeko

## 预览

![能力地图]({parts["image"]})

## 安装

- [Node.js](https://nodejs.org/) {parts["node"]}
- [pnpm](https://pnpm.io/) {parts["pnpm"]}
- [Rust](https://rustup.rs/) —— 版本固定在 rust-toolchain.toml

## 功能特性

### 终端与 Agent

- **{parts["agent_count"]} 个内置 CLI Agent** —— {parts["agents"]}
- **自定义 Agent** —— 添加自己的 CLI

内置 MockAgent 让你在没装任何 CLI 时也能试用对话。
{parts["table"]}{parts["extra"]}
## 参考

- **键盘快捷键** —— [docs/keyboard-shortcuts.md](docs/keyboard-shortcuts.md)
- **主题** —— {parts["themes"]} 个内置主题（Dark、Light、One Dark Pro、Claude、Classic Dark）
"""


def providers(ids=None) -> str:
    ids = ids if ids is not None else CLI_IDS + ["mockAgent"]
    body = "\n".join(f'        shell_agent(\n            "{i}",' for i in ids if i != "mockAgent")
    explicit = "\n".join(
        f'            id: "{i}".into(),' for i in ids if i == "mockAgent"
    )
    return f"pub fn builtin_configs() -> Vec<AgentConfig> {{\n    vec![\n{body}\n{explicit}\n    ]\n}}\n"


class ReadmeClaimsTest(unittest.TestCase):
    def setUp(self):
        self.root = temp_repo(self)

    def seed(self, en: str | None = None, cn: str | None = None, files: dict | None = None):
        base = {
            subject.README_EN: en if en is not None else readme_en(),
            subject.README_CN: cn if cn is not None else readme_cn(),
            subject.PACKAGE_JSON: '{"engines":{"node":">=24"},"packageManager":"pnpm@11.25.0"}',
            subject.TOOLCHAIN: '[toolchain]\nchannel = "1.99.0"\n',
            subject.SETTINGS: (
                "export const BUILTIN_THEMES = ["
                + ", ".join(f"'{t}'" for t in THEMES)
                + "] as const;\n"
            ),
            subject.PROVIDERS: providers(),
            "docs/.img/capability-map.svg": "<svg/>",
            "docs/keyboard-shortcuts.md": "# shortcuts\n",
        }
        base.update(files or {})
        make_repo(self.root, base)
        return subject.check(context(self.root))

    def test_clean_readme_passes(self):
        result = self.seed()
        self.assertEqual(result.verdict, PASS, result.findings)
        self.assertIn("themes=5", result.metrics)

    def test_node_version_mismatch_is_a_violation(self):
        result = self.seed(cn=readme_cn(node="22+"))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("Node" in f.message for f in result.findings), result.findings)

    def test_missing_agent_name_is_a_violation(self):
        agents = "、".join(list(subject.CLI_AGENT_NAMES.values())[:-1])
        result = self.seed(cn=readme_cn(agents=agents))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("Grok" in f.message for f in result.findings), result.findings)

    def test_agent_count_must_match_code(self):
        result = self.seed(en=readme_en(agent_count="9"))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("真实值 10" in f.message for f in result.findings), result.findings)

    def test_theme_count_mismatch_is_a_violation(self):
        result = self.seed(en=readme_en(themes="4"))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("主题" in f.message or "themes" in f.message for f in result.findings))

    def test_shortcut_table_is_a_violation(self):
        table = "\n| Shortcut | Action |\n| --- | --- |\n| `Ctrl+R` | refresh |\n"
        result = self.seed(en=readme_en(table=table))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("快捷键" in f.message for f in result.findings), result.findings)

    def test_missing_image_is_a_violation(self):
        result = self.seed(en=readme_en(image="docs/.img/shell-projects.webp"))
        self.assertEqual(result.verdict, VIOLATION)
        self.assertTrue(any("图片" in f.message for f in result.findings), result.findings)

    def test_commented_out_image_is_ignored(self):
        """HTML 注释里的图注不参与判定 —— 注释掉的待定图片不该判违规（§18(b) 同型）。"""
        en = readme_en(image="docs/.img/shell-projects.webp")
        en = en.replace(
            "![capability map](docs/.img/shell-projects.webp)",
            "<!-- 待定：![capability map](docs/.img/shell-projects.webp) -->",
        )
        result = self.seed(en=en)
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_commented_out_shortcut_table_is_ignored(self):
        table = "\n<!--\n| Shortcut | Action |\n| --- | --- |\n| `Ctrl+R` | refresh |\n-->\n"
        result = self.seed(en=readme_en(table=table))
        self.assertEqual(result.verdict, PASS, result.findings)

    def test_missing_providers_is_an_infra_failure(self):
        make_repo(
            self.root,
            {
                subject.README_EN: readme_en(),
                subject.README_CN: readme_cn(),
                subject.PACKAGE_JSON: '{"engines":{"node":">=24"},"packageManager":"pnpm@11.25.0"}',
                subject.TOOLCHAIN: '[toolchain]\nchannel = "1.99.0"\n',
                subject.SETTINGS: "export const BUILTIN_THEMES = ['dark'] as const;\n",
            },
        )
        result = subject.check(context(self.root))
        self.assertEqual(result.verdict, ERROR)
        self.assertIn(subject.PROVIDERS, result.error)

    def test_unparseable_providers_is_an_infra_failure(self):
        """解析口径失效（构造方式改了）必须响亮失败，不能"抽取 0 个 = 全部满足"。"""
        result = self.seed(files={subject.PROVIDERS: "pub fn builtin_configs() {}\n"})
        self.assertEqual(result.verdict, ERROR)
        self.assertIn("0 个内置 agent", result.error)


if __name__ == "__main__":
    unittest.main()
