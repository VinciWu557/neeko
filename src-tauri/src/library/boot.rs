//! 启动期 library 引导：保证默认 Tag Group 存在。
//!
//! 规则（本模块拥有）：library 是空的（从未装过任何 skill / 分组）时创建 `Default`
//! 分组，让前端分组视图有初始落点；**只要已有任何分组就一律不动**（幂等，绝不覆盖
//! 用户数据）。

use crate::library::skill::types::TagGroupRecord;
use crate::library::LibraryStore;

/// 默认分组名（前端按名称展示）。
const DEFAULT_TAG_GROUP_NAME: &str = "Default";
/// 默认分组图标（前端图标名）。
const DEFAULT_TAG_GROUP_ICON: &str = "clipboard-list";
/// 默认分组描述。
const DEFAULT_TAG_GROUP_DESCRIPTION: &str = "Default skill group";

/// 没有任何 Tag Group 时创建 `Default`；已有分组一律不动。
pub fn ensure_default_tag_group(store: &LibraryStore) {
    let groups = match store.get_all_tag_groups() {
        Ok(groups) => groups,
        Err(e) => {
            log::warn!("[boot] failed to read skill tag groups: {e}");
            return;
        }
    };
    if !groups.is_empty() {
        return;
    }

    let now = chrono::Utc::now().timestamp_millis();
    let default_group = TagGroupRecord {
        id: uuid::Uuid::new_v4().to_string(),
        name: DEFAULT_TAG_GROUP_NAME.to_string(),
        description: Some(DEFAULT_TAG_GROUP_DESCRIPTION.to_string()),
        icon: Some(DEFAULT_TAG_GROUP_ICON.to_string()),
        sort_order: 0,
        created_at: now,
        updated_at: now,
    };
    match store.insert_tag_group(&default_group) {
        Ok(()) => log::info!("[boot] created the default skill tag group"),
        Err(e) => log::warn!("[boot] failed to create the default skill tag group: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tag_groups(store: &LibraryStore) -> Vec<TagGroupRecord> {
        store.get_all_tag_groups().expect("read tag groups")
    }

    /// 空库 → 创建 `Default`；重复调用幂等（第二次不得再插一条）。
    #[test]
    fn creates_default_group_once() {
        let store = LibraryStore::open_in_memory().expect("store");

        ensure_default_tag_group(&store);
        let groups = tag_groups(&store);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, DEFAULT_TAG_GROUP_NAME);

        ensure_default_tag_group(&store);
        assert_eq!(tag_groups(&store).len(), 1, "幂等：已有分组不得重复创建");
    }

    /// 已有分组（用户数据）→ 一律不动。
    #[test]
    fn keeps_existing_groups_untouched() {
        let store = LibraryStore::open_in_memory().expect("store");
        let now = chrono::Utc::now().timestamp_millis();
        store
            .insert_tag_group(&TagGroupRecord {
                id: "user-group".to_string(),
                name: "Mine".to_string(),
                description: None,
                icon: None,
                sort_order: 0,
                created_at: now,
                updated_at: now,
            })
            .expect("insert");

        ensure_default_tag_group(&store);

        let groups = tag_groups(&store);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].name, "Mine", "用户分组不得被 Default 覆盖/追加");
    }
}
