import { memo } from 'react';

import agentChatIcon from '../../assets/agents/agent-chat.svg';

interface AgentChatProps {
  /** 图标边长（px），与 Lucide 的 `size` 同语义。 */
  size?: number | string;
  className?: string;
  /** 与 HTML 属性取值一致（调用方可能写 `aria-hidden="true"` 字符串）。 */
  'aria-hidden'?: boolean | 'true' | 'false';
}

/**
 * Agent Chat 品牌图标（`assets/agents/agent-chat.svg`），按 Lucide 组件形态封装
 * （`size` / `className` / `aria-hidden`），与 `<Bot size={18} />` 同用法。
 *
 * Tab 标签、动作菜单/命令面板、引导页共用这一个实现 —— 换图标只改 svg 文件。
 */
const AgentChat: React.FC<AgentChatProps> = ({ size = 18, className, ...rest }) => (
  <img src={agentChatIcon} width={size} height={size} className={className} alt="" {...rest} />
);

export default memo(AgentChat);
