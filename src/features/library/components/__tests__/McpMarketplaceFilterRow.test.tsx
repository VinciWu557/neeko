import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import McpMarketplaceFilterRow from '../McpMarketplaceFilterRow';

type RowProps = Parameters<typeof McpMarketplaceFilterRow>[0];

function setupRow(overrides: Partial<RowProps> = {}) {
  const props: RowProps = {
    transportFilter: null,
    onTransportFilterChange: vi.fn(),
    availableTransports: ['stdio', 'http'],
    sortMode: 'recent',
    onSortModeChange: vi.fn(),
    ...overrides,
  };
  render(<McpMarketplaceFilterRow {...props} />);
  return props;
}

describe('McpMarketplaceFilterRow', () => {
  it('点击传输 chip → 选中该值', () => {
    const props = setupRow();
    fireEvent.click(screen.getByRole('button', { name: 'stdio' }));
    expect(props.onTransportFilterChange).toHaveBeenLastCalledWith('stdio');
  });

  it('已选中该 chip 时再点 → 清除过滤（null）', () => {
    const props = setupRow({ transportFilter: 'stdio' });
    fireEvent.click(screen.getByRole('button', { name: 'stdio' }));
    expect(props.onTransportFilterChange).toHaveBeenLastCalledWith(null);
  });

  it('All 按钮清空过滤', () => {
    const props = setupRow({ transportFilter: 'http' });
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(props.onTransportFilterChange).toHaveBeenLastCalledWith(null);
  });

  it('排序按钮切换 → 对应模式；chip 只渲染 availableTransports 传入的项', () => {
    const props = setupRow({ availableTransports: ['stdio'] });

    fireEvent.click(screen.getByRole('button', { name: 'A–Z' }));
    expect(props.onSortModeChange).toHaveBeenLastCalledWith('alpha');

    fireEvent.click(screen.getByRole('button', { name: 'Downloads' }));
    expect(props.onSortModeChange).toHaveBeenLastCalledWith('downloads');

    // availableTransports 只含 stdio → 不渲染 http 的 chip
    expect(screen.queryByRole('button', { name: 'http' })).not.toBeInTheDocument();
  });
});
