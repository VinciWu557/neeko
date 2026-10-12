import React from 'react';

import { useLibraryStore } from '@/features/library/store/libraryStore';
import { SkillsPanel } from '@/features/skill';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import { buildScrollKey } from '@/shared/utils/scrollMemory';

import LibrarySidebar from './LibrarySidebar';
import McpNavPanel from './McpNavPanel';

const LibraryNavTree: React.FC = React.memo(() => {
  const activeKind = useLibraryStore((s) => s.activeKind);
  // 滚动记忆：Library 常驻（hidden 切换）期引擎丢位置 / 卸载重建都恢复；按资源类型隔离。
  const scrollRef = useScrollMemory<HTMLDivElement>(
    buildScrollKey('library.nav', null, activeKind),
  );

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto">
      {activeKind === 'skill' && <SkillsPanel />}
      {activeKind === 'prompt' && <LibrarySidebar />}
      {activeKind === 'mcp' && <McpNavPanel />}
    </div>
  );
});

LibraryNavTree.displayName = 'LibraryNavTree';

export default LibraryNavTree;
