/**
 * agentCallbacks.ts
 *
 * Registers window bridge callbacks for agent management and selection context:
 * addSelectionInfo, addCodeSnippet, clearSelectionInfo,
 * onSelectedAgentReceived, onSelectedAgentChanged.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import { isAutoOpenFileGateEnabled } from '../../../utils/autoOpenFileGate';
import {
  parseSelectionInfo,
  shouldApplyAutoSelectionInfo,
} from '../../../utils/selectionInfo';

export function registerAgentAndSelectionCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    setContextInfo,
    setSelectedAgent,
  } = options;

  window.addSelectionInfo = (selectionInfo) => {
    // Auto file sync must respect "发送打开的文件路径". Manual snippet insert uses
    // insertCodeSnippetAtCursor / addCodeSnippet and is intentionally not gated.
    if (!shouldApplyAutoSelectionInfo(isAutoOpenFileGateEnabled())) {
      return;
    }
    const parsed = parseSelectionInfo(selectionInfo);
    if (parsed) {
      setContextInfo(parsed);
    }
  };

  window.addCodeSnippet = (selectionInfo) => {
    if (selectionInfo && window.insertCodeSnippetAtCursor) {
      window.insertCodeSnippetAtCursor(selectionInfo);
    }
  };

  window.clearSelectionInfo = () => {
    setContextInfo(null);
  };

  window.onSelectedAgentReceived = (json) => {
    try {
      if (!json || json === 'null' || json === '{}') {
        setSelectedAgent(null);
        return;
      }
      const data = JSON.parse(json);
      const agentFromNewShape = data?.agent;
      const agentFromLegacyShape = data;

      const agentData = agentFromNewShape?.id
        ? agentFromNewShape
        : agentFromLegacyShape?.id
          ? agentFromLegacyShape
          : null;
      if (!agentData) {
        setSelectedAgent(null);
        return;
      }

      setSelectedAgent({
        id: agentData.id,
        name: agentData.name || '',
        prompt: agentData.prompt,
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse selected agent:', error);
      setSelectedAgent(null);
    }
  };

  window.onSelectedAgentChanged = (json) => {
    try {
      if (!json || json === 'null' || json === '{}') {
        setSelectedAgent(null);
        return;
      }

      const data = JSON.parse(json);
      if (data?.success === false) {
        return;
      }

      const agentFromNewShape = data?.agent;
      const agentFromLegacyShape = data;
      const agentData = agentFromNewShape?.id
        ? agentFromNewShape
        : agentFromLegacyShape?.id
          ? agentFromLegacyShape
          : null;
      if (!agentData || !agentData.id) {
        setSelectedAgent(null);
        return;
      }

      setSelectedAgent({
        id: agentData.id,
        name: agentData.name || '',
        prompt: agentData.prompt,
      });
    } catch (error) {
      console.error('[Frontend] Failed to parse selected agent changed:', error);
    }
  };
}
