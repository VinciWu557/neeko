import { describe, expect, it } from 'vitest';

import { editorBasePathOf } from '@/features/editor/hooks/useFileEditorState';
import { WorkspaceSession } from '@/shared/utils/workspaceRef';

const mainKey = WorkspaceSession.of('p1', null).key;
const worktreeKey = WorkspaceSession.of('p1', '/repo/.worktrees/feat-x').key;

describe('editorBasePathOf（md/html 预览的资源基准目录）', () => {
  it('主 checkout：基准 = projectPath/文件所在目录', () => {
    expect(editorBasePathOf(mainKey, '/repo', 'docs/a.md')).toBe('/repo/docs');
  });

  it('文件在项目根：基准 = 根', () => {
    expect(editorBasePathOf(mainKey, '/repo', 'README.md')).toBe('/repo');
  });

  it('linked worktree：基准 = 工作树根（不是主仓根，回归锁定）', () => {
    // 历史实现只用 projectPath ⇒ worktree 里 md 的相对图片会被拼到主仓根，解析到另一个文件。
    expect(editorBasePathOf(worktreeKey, '/repo', 'docs/a.md')).toBe(
      '/repo/.worktrees/feat-x/docs',
    );
  });

  it('绝对 filePath 不与根二次拼接（历史 "E:/ws/C:/project" 双根 bug）', () => {
    expect(editorBasePathOf(mainKey, '/repo', '/elsewhere/docs/a.md')).toBe('/elsewhere/docs');
  });

  it('反斜杠与多斜杠归一', () => {
    expect(editorBasePathOf(mainKey, '/repo/', 'docs\\a.md')).toBe('/repo/docs');
  });
});
