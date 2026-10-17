//! 三种**接入形态**，各自一条实现腿（`InstallShape` 的变体一一对应）。
//!
//! 加一种形态 = 加一个文件 + 在 `dispatch` / `status` 各补一个 arm
//!（`enum + match` 编译期穷尽会强制你处理，这是预期代价而非缺陷）。
//!
//! 三条腿共享 `super::shim::ownership` 的归属守卫 —— 守卫的调用点存在性由
//! `install/tests.rs` 的反证用例钉住。

pub mod notify_argv;
pub mod standalone;
pub mod structured;
