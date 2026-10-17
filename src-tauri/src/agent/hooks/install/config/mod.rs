//! 用户配置的**纯变换**（零 IO）：JSON / TOML 的定点增删、逐 CLI 开关解析。
//!
//! 这些模块一律「`Value`/`&str` 进 → 新值 + 回执出」，不碰文件系统 —— 故可 100% 用
//! 内联字符串夹具直测，也让「合并规则」与「怎么落盘」两个关注点彻底分开
//!（落盘在 [`super::shim::config_io`]）。

pub mod json;
pub mod settings;
pub mod toml;
