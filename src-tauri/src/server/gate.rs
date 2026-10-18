//! 统一鉴权门（设计 §3.2）。
//!
//! # 唯一性
//!
//! 进程内只有 [`AuthGate::authorize`] 一处调用恒定时间比较（AC7 判据：`ct_eq` 调用点 = 1）。
//! [`CredentialExt`] 的实现体**只提取候选字节、不返回布尔** —— 结构上无法各自实现比较逻辑，
//! 这比「约定不要重复写比较」强得多。
//!
//! # 零 panic 是结构性要求
//!
//! 门装在全局层（组内 `CatchPanicLayer` 之外）：门自身 panic 没有任何兜底层可接，
//! hyper 会直接掐断连接（hooks 组因此漏出非 204）。故本文件所有路径对任意畸形请求头
//! 都必须零 panic —— 无索引、无锁、无分配失败路径。

use std::sync::Arc;

use axum::http::HeaderMap;
use subtle::ConstantTimeEq;

/// 凭证提取器：**只负责「从传输里取出候选凭证」**，不负责比较。
///
/// 新增凭证形状（Bearer scheme / cookie / query）＝新增一个 impl 并 push 进门的凭证列表；
/// 仲裁策略与代码零改动（A4）。
pub trait CredentialExt: Send + Sync {
    /// 从请求头取出候选凭证；`None` = 本请求没带这种凭证。
    fn extract<'a>(&self, headers: &'a HeaderMap) -> Option<&'a [u8]>;
}

/// 当前唯一实现：header token（形状与 shim / endpoint 文件契约同源）。
pub struct HeaderToken {
    /// header 名（hooks 组 = `x-neeko-agent-hook-token`，常量来自 kernel 模块）。
    pub name: &'static str,
}

impl CredentialExt for HeaderToken {
    fn extract<'a>(&self, headers: &'a HeaderMap) -> Option<&'a [u8]> {
        // `get` 对重复头名返回首值；非 ASCII 字节原样返回交给恒定时间比较
        // （hyper 已在解析期拒绝非法 header，这里不做二次校验 = 无 panic 路径）。
        headers
            .get(self.name)
            .map(axum::http::HeaderValue::as_bytes)
    }
}

/// 统一鉴权门：进程内唯一的能力裁决点（AC7）。
pub struct AuthGate {
    /// 本实例签发的能力（token）。
    expected: String,
    /// 全部可接受的凭证形状（OR 语义：任一命中即通过）。
    credentials: Vec<Arc<dyn CredentialExt>>,
}

impl AuthGate {
    /// 构造门。**没有「本组免鉴权」构造路径** —— 门对每个路由组强制生效（A4）。
    ///
    /// 凭证列表为空时 `authorize` 恒 false（结构性证明：不存在「什么都不用带」的配置）。
    #[must_use]
    pub fn new(expected: String, credentials: Vec<Arc<dyn CredentialExt>>) -> Self {
        Self {
            expected,
            credentials,
        }
    }

    /// 裁决：任一凭证提取成功且恒定时间匹配即通过。
    #[must_use]
    pub fn authorize(&self, headers: &HeaderMap) -> bool {
        let expected = self.expected.as_bytes();
        self.credentials.iter().any(|credential| {
            credential
                .extract(headers)
                .is_some_and(|candidate| ct_eq(candidate, expected))
        })
    }
}

/// 恒定时间比较（AC7 的唯一实现）。
///
/// 长度不等直接 false：长度不是秘密（token 是定长 uuid），而 `ConstantTimeEq` 对不等长
/// 切片本就无法定长比较。内容比较走 `subtle`，避免时序侧信道。
fn ct_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && bool::from(a.ct_eq(b))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "tok-abc-123";

    fn gate() -> AuthGate {
        AuthGate::new(
            TOKEN.to_string(),
            vec![Arc::new(HeaderToken {
                name: "x-neeko-token",
            })],
        )
    }

    fn headers(name: &'static str, value: &'static str) -> HeaderMap {
        let mut map = HeaderMap::new();
        map.insert(name, value.parse().expect("valid header value"));
        map
    }

    #[test]
    fn correct_token_is_authorized() {
        assert!(gate().authorize(&headers("x-neeko-token", TOKEN)));
    }

    #[test]
    fn wrong_or_missing_token_is_rejected() {
        let gate = gate();
        assert!(!gate.authorize(&headers("x-neeko-token", "stale")));
        assert!(!gate.authorize(&headers("x-neeko-token", "tok-abc-12"))); // 前缀不得通过
        assert!(!gate.authorize(&headers("x-neeko-token", "tok-abc-1234"))); // 超长不得通过
        assert!(!gate.authorize(&HeaderMap::new()));
    }

    /// header 名大小写由 HTTP 规范保证（`HeaderMap` 内部小写归一），此处钉住该前提。
    #[test]
    fn header_name_matching_is_case_insensitive() {
        assert!(gate().authorize(&headers("X-Neeko-Token", TOKEN)));
    }

    /// 空凭证列表恒拒 —— 「免鉴权」配置在结构上不存在（A4）。
    #[test]
    fn empty_credential_list_always_rejects() {
        let gate = AuthGate::new(TOKEN.to_string(), Vec::new());
        assert!(!gate.authorize(&headers("x-neeko-token", TOKEN)));
    }

    /// 多凭证 OR 语义：任一形状命中即通过，且不会因为前一个不匹配而短路成拒绝。
    #[test]
    fn multiple_credentials_use_or_semantics() {
        struct Fixed(&'static str);
        impl CredentialExt for Fixed {
            fn extract<'a>(&self, _headers: &'a HeaderMap) -> Option<&'a [u8]> {
                Some(self.0.as_bytes())
            }
        }

        let gate = AuthGate::new(
            TOKEN.to_string(),
            vec![
                Arc::new(HeaderToken {
                    name: "x-neeko-token",
                }),
                Arc::new(Fixed("other-shape")),
                Arc::new(Fixed(TOKEN)),
            ],
        );
        // 第一条不匹配、第三条匹配 → 通过。
        assert!(gate.authorize(&HeaderMap::new()));
    }

    /// 门在组内 `CatchPanicLayer` 之外：任意畸形头都不得 panic（design §3.2）。
    ///
    /// 构造手段：非 ASCII 字节值（hyper 在真实链路上会在解析期拒绝，但门不能依赖
    /// 「上游一定挡住」）、超长值、重复头名（`HeaderMap` 保留首个）、空值。
    #[test]
    fn malformed_headers_never_panic() {
        let gate = gate();

        let mut non_ascii = HeaderMap::new();
        non_ascii.insert(
            "x-neeko-token",
            axum::http::HeaderValue::from_bytes(&[0xff, 0xfe, 0xfd]).expect("opaque bytes allowed"),
        );
        assert!(!gate.authorize(&non_ascii));

        let mut long = HeaderMap::new();
        let value = "a".repeat(64 * 1024);
        long.insert(
            "x-neeko-token",
            value.parse().expect("long ascii header value"),
        );
        assert!(!gate.authorize(&long));

        let mut duplicate = HeaderMap::new();
        duplicate.append("x-neeko-token", "wrong".parse().expect("valid"));
        duplicate.append("x-neeko-token", TOKEN.parse().expect("valid"));
        // 首值不匹配 → 拒绝（不 panic、不跨值拼接）。
        assert!(!gate.authorize(&duplicate));

        let mut empty = HeaderMap::new();
        empty.insert("x-neeko-token", "".parse().expect("empty allowed"));
        assert!(!gate.authorize(&empty));
    }
}
