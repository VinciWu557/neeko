import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MarkdownImage } from '@/ui/MarkdownImage';

// setup.ts 全局 mock：convertFileSrc → `asset://localhost/${path}`
beforeEach(() => {
  vi.clearAllMocks();
});

describe('MarkdownImage', () => {
  it('相对路径按 basePath 解析成 asset URL（本任务的核心修复）', () => {
    render(<MarkdownImage src="img/a.png" alt="a" basePath="/proj/docs" />);
    expect(screen.getByAltText('a')).toHaveAttribute(
      'src',
      'asset://localhost//proj/docs/img/a.png',
    );
  });

  it('data URI 在传入 basePath 时不被改写成 asset URL', () => {
    const dataUri = 'data:image/png;base64,iVBORw0KGgo=';
    render(<MarkdownImage src={dataUri} alt="inline" basePath="/proj/docs" />);
    expect(screen.getByAltText('inline')).toHaveAttribute('src', dataUri);
  });

  it('http(s) 外链原样使用', () => {
    render(<MarkdownImage src="https://a.com/x.webp" alt="remote" basePath="/proj" />);
    expect(screen.getByAltText('remote')).toHaveAttribute('src', 'https://a.com/x.webp');
  });

  it('无 basePath 的相对路径保持原样（无项目语境时不瞎猜）', () => {
    render(<MarkdownImage src="img/a.png" alt="plain" />);
    expect(screen.getByAltText('plain')).toHaveAttribute('src', 'img/a.png');
  });

  it('点击图片打开全屏遮罩，Escape / 点击遮罩关闭', () => {
    render(<MarkdownImage src="/tmp/a.png" alt="big" basePath="/proj" />);
    expect(screen.queryByRole('button', { name: /close image preview/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByAltText('big'));
    const overlay = screen.getByRole('button', { name: /close image preview/i });
    fireEvent.keyDown(overlay, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: /close image preview/i })).not.toBeInTheDocument();
  });

  it('加载失败时显示 alt 兜底而非破图', () => {
    render(<MarkdownImage src="/nonexistent/a.png" alt="Broken" basePath="/proj" />);
    fireEvent.error(screen.getByAltText('Broken'));
    expect(screen.queryByAltText('Broken')).not.toBeInTheDocument();
    expect(screen.getByText('Broken')).toBeInTheDocument();
  });
});
