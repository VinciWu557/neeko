export { default as TerminalView } from './components/TerminalView';
export {
  terminalCache,
  terminalRebuildCallbacks,
  terminalWrapperRefs,
  wslTerminalCache,
  wslRebuildCallbacks,
  wslWrapperRefs,
  remoteTerminalCache,
  remoteRebuildCallbacks,
  remoteWrapperRefs,
} from './components/terminalCache';
export {
  terminalAddress,
  terminalAddressPrefix,
  terminalAddressPrefixOfTab,
  terminalKeyLabel,
  decodeTerminalKey,
  resolveTerminalEntry,
  firstTerminalEntryOfSession,
  firstTerminalKeyOfSession,
  destroyTerminalsForProject,
  destroyTerminalsForSession,
  destroyTerminalsForTab,
  refreshTerminalForSession,
  refreshTerminalEntry,
} from './components/terminalCache';
export {
  sendToTerminal,
  pasteToTerminal,
  pasteToTerminalSession,
  wrapBracketedPaste,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
} from './components/terminalCommands';
export { switchAgentInTerminal } from './components/terminalAgentSwitch';
export {
  cleanupTerminalsForTab,
  cleanupTerminalsForTabKey,
  closeEditorTab,
  closeAllEditorTabs,
} from './components/terminalTabCleanup';
export {
  foregroundTerminalTab,
  insertToSessionTerminal,
  type ForegroundTerminal,
  type InsertToSessionTerminalResult,
} from './components/terminalRouting';

export { default as SplitLayout, type SplitStateInfo } from './components/SplitLayout';
export { updateAllTerminalThemes } from './components/index';
export type { TerminalTab } from './types';
export { useTerminalTabs } from './hooks/useTerminalTabs';
export {
  MAX_TERMINAL_TABS,
  createTaskTerminal,
  generateTerminalTabId,
  type TaskTerminalOptions,
} from './api/taskTerminal';

export { useTerminalStrategy } from './strategies';
