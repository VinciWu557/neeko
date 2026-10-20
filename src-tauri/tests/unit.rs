//! Integration test entry point aggregating the unit test submodules.

// 与 lib 根同款豁免口径：集成测试是独立 crate，`[lints.clippy]` 的 deny 同样适用于它，
// 断言里的 expect/unwrap 在此显式降级为 warn（见 `src/lib.rs` 同名属性）。
#![cfg_attr(test, allow(clippy::expect_used, clippy::unwrap_used))]

#[path = "unit/acp_test.rs"]
mod acp_test;
#[path = "unit/agent_model_dispatch_test.rs"]
mod agent_model_dispatch_test;
#[path = "unit/agent_test.rs"]
mod agent_test;
#[path = "unit/git_test.rs"]
mod git_test;
#[path = "unit/http_gateway_test.rs"]
mod http_gateway_test;
#[path = "unit/project_test.rs"]
mod project_test;
#[path = "unit/state_test.rs"]
mod state_test;
#[path = "unit/storage_test.rs"]
mod storage_test;
#[path = "unit/support.rs"]
mod support;
