import React from 'react';

import { cn } from '@/lib/utils';
import { ArrowLeft, Search, FolderOpen } from '@/shared/components/icons';
import { useScrollMemory } from '@/shared/hooks/useScrollMemory';
import type { Project } from '@/shared/types';
import { buildScrollKey } from '@/shared/utils/scrollMemory';

import type { NavItem, SettingsNavId } from './constants';

interface SettingsSidebarProps {
  onBack: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  /** 已按搜索词过滤的导航项（过滤逻辑留在 SettingsView）。 */
  navItems: NavItem[];
  activeNav: SettingsNavId;
  onSelectNav: (nav: SettingsNavId) => void;
  projects: Project[];
}

/** 设置页左侧导航（返回 / 搜索 / 导航项 / 项目入口）。从 SettingsView 抽出，行为零漂移。 */
function SettingsSidebar({
  onBack,
  searchQuery,
  onSearchChange,
  navItems,
  activeNav,
  onSelectNav,
  projects,
}: SettingsSidebarProps) {
  // 滚动记忆：离开设置（卸载）后返回时恢复导航区滚动位置。
  const scrollRef = useScrollMemory<HTMLDivElement>(buildScrollKey('settings.nav'));

  return (
    <nav className="w-[200px] shrink-0 border-r border-border flex flex-col overflow-hidden">
      {/* Back button */}
      <div className="px-3 pt-3 pb-2">
        <button
          className="flex items-center gap-1.5 text-[0.86em] text-text-secondary hover:text-text-primary transition-colors duration-150 cursor-pointer"
          onClick={onBack}
        >
          <ArrowLeft size={14} strokeWidth={2} />
          <span>Back</span>
        </button>
      </div>

      {/* Search box */}
      <div className="px-3 pb-2">
        <div className="relative">
          <Search
            size={13}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none"
          />
          <input
            type="text"
            placeholder="Search..."
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            className="w-full h-7 pl-7 pr-2 text-[0.82em] bg-bg-tertiary border border-border rounded-md text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-blue transition-colors duration-150"
          />
        </div>
      </div>

      {/* Navigation items */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-1.5 pb-2 flex flex-col gap-0.5">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={cn(
              'flex items-center gap-2.5 py-2 px-3 bg-none border-none rounded-md text-text-secondary text-[0.86em] cursor-pointer text-left transition-[background-color,color] duration-150 w-full hover:bg-bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent-blue focus-visible:ring-offset-1',
              activeNav === item.id && '!bg-accent-blue !text-[var(--text-on-accent)]',
            )}
            onClick={() => onSelectNav(item.id)}
          >
            <span
              className={cn(
                'text-text-muted shrink-0 flex items-center',
                activeNav === item.id && '!text-[var(--text-on-accent)]',
              )}
            >
              {item.icon}
            </span>
            <span className="font-medium">{item.label}</span>
          </button>
        ))}

        {/* Projects section */}
        {projects.length > 0 && (
          <>
            <div className="h-px bg-border mx-1.5 my-2" />
            <div className="px-3 py-1 text-[0.72em] font-semibold text-text-muted uppercase tracking-wider">
              Projects
            </div>
            {projects.map((p) => {
              const navId: SettingsNavId = `project:${p.id}`;
              return (
                <button
                  key={p.id}
                  className={cn(
                    'flex items-center gap-2.5 py-2 px-3 pl-5 bg-none border-none rounded-md text-text-secondary text-[0.86em] cursor-pointer text-left transition-[background-color,color] duration-150 w-full hover:bg-bg-hover hover:text-text-primary',
                    activeNav === navId && '!bg-accent-blue !text-[var(--text-on-accent)]',
                  )}
                  onClick={() => onSelectNav(navId)}
                >
                  <FolderOpen
                    size={14}
                    className={cn(
                      'shrink-0 text-text-muted',
                      activeNav === navId && '!text-[var(--text-on-accent)]',
                    )}
                  />
                  <span className="font-medium truncate">{p.name}</span>
                </button>
              );
            })}
          </>
        )}

        {projects.length === 0 && (
          <>
            <div className="h-px bg-border mx-1.5 my-2" />
            <div className="px-3 py-1 text-[0.72em] font-semibold text-text-muted uppercase tracking-wider">
              Projects
            </div>
            <div className="px-3 py-4 text-[0.79em] text-text-muted text-center">
              No projects added yet.
            </div>
          </>
        )}
      </div>
    </nav>
  );
}

export default React.memo(SettingsSidebar);
