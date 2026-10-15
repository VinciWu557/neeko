import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';

import SessionChips from '@/shared/components/SessionChips';

describe('SessionChips.Ahead', () => {
  it('ahead > 0 时渲染 ↑N', () => {
    render(<SessionChips.Ahead ahead={208} />);
    expect(screen.getByText('↑208')).toBeInTheDocument();
  });

  it('ahead = 0 时不渲染', () => {
    const { container } = render(<SessionChips.Ahead ahead={0} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('ahead 为负数时不渲染（防御性）', () => {
    const { container } = render(<SessionChips.Ahead ahead={-1} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('SessionChips.Kbd', () => {
  it('渲染 children 内容', () => {
    render(<SessionChips.Kbd>⌘1</SessionChips.Kbd>);
    expect(screen.getByText('⌘1')).toBeInTheDocument();
  });
});
