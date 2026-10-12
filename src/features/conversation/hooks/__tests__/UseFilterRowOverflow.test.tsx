import { render, screen } from '@testing-library/react';
import React, { useRef } from 'react';
import { afterAll, describe, expect, it } from 'vitest';

import { useFilterRowOverflow } from '../useFilterRowOverflow';

const origScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
const origClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');

let scrollHeight = 24;
let clientHeight = 24;

Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get: () => scrollHeight,
});
Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
  configurable: true,
  get: () => clientHeight,
});

afterAll(() => {
  if (origScrollHeight)
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', origScrollHeight);
  if (origClientHeight)
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientHeight);
});

function Harness({ optionCount, expanded }: { optionCount: number; expanded: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const overflow = useFilterRowOverflow(ref, optionCount, expanded);
  return <div ref={ref} data-testid="row" data-overflow={overflow ? '1' : '0'} />;
}

describe('useFilterRowOverflow', () => {
  it('折叠态且 chip 换行（scrollHeight 超单行）→ true', () => {
    scrollHeight = 30;
    clientHeight = 24;
    render(<Harness optionCount={5} expanded={false} />);
    expect(screen.getByTestId('row').dataset.overflow).toBe('1');
  });

  it('单行不溢出 → false', () => {
    scrollHeight = 24;
    clientHeight = 24;
    render(<Harness optionCount={5} expanded={false} />);
    expect(screen.getByTestId('row').dataset.overflow).toBe('0');
  });

  it('选项不足 2 个 → false（无需测量）', () => {
    scrollHeight = 999;
    clientHeight = 24;
    render(<Harness optionCount={1} expanded={false} />);
    expect(screen.getByTestId('row').dataset.overflow).toBe('0');
  });

  it('展开态不测量 → false', () => {
    scrollHeight = 999;
    clientHeight = 24;
    render(<Harness optionCount={5} expanded />);
    expect(screen.getByTestId('row').dataset.overflow).toBe('0');
  });
});
