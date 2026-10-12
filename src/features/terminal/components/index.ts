export { default as TerminalView } from './TerminalView';
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
} from './terminalCache';
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
} from './terminalCache';
export {
  sendToTerminal,
  pasteToTerminal,
  pasteToTerminalSession,
  wrapBracketedPaste,
  BRACKETED_PASTE_START,
  BRACKETED_PASTE_END,
} from './terminalCommands';
export { switchAgentInTerminal } from './terminalAgentSwitch';
export {
  cleanupTerminalsForTab,
  cleanupTerminalsForTabKey,
  closeEditorTab,
  closeAllEditorTabs,
} from './terminalTabCleanup';
export {
  foregroundTerminalTab,
  insertToSessionTerminal,
  type ForegroundTerminal,
  type InsertToSessionTerminalResult,
} from './terminalRouting';

export { default as SplitLayout } from './SplitLayout';

import { buildTerminalTheme } from '@/shared/utils/terminal';

import { terminalCache, wslTerminalCache, remoteTerminalCache } from './terminalCache';

export function updateAllTerminalThemes() {
  const theme = buildTerminalTheme();
  for (const cache of terminalCache.values()) {
    cache.term.options.theme = theme;
  }
  for (const cache of wslTerminalCache.values()) {
    cache.term.options.theme = theme;
  }
  for (const cache of remoteTerminalCache.values()) {
    cache.term.options.theme = theme;
  }
}
