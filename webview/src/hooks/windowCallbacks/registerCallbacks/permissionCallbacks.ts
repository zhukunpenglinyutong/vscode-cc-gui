/**
 * permissionCallbacks.ts
 *
 * Registers window bridge callbacks for permission dialogs:
 * showPermissionDialog, showAskUserQuestionDialog, showPlanApprovalDialog.
 * Also drains any pending dialog requests queued before React mounted.
 */

import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';

export function registerPermissionCallbacks(options: UseWindowCallbacksOptions): void {
  const {
    openPermissionDialog,
    openAskUserQuestionDialog,
    openPlanApprovalDialog,
  } = options;

  window.showPermissionDialog = (json) => {
    try {
      const request = JSON.parse(json);
      openPermissionDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse permission request:', error);
    }
  };

  if (
    Array.isArray(window.__pendingPermissionDialogRequests) &&
    window.__pendingPermissionDialogRequests.length > 0
  ) {
    const pending = window.__pendingPermissionDialogRequests.slice();
    window.__pendingPermissionDialogRequests = [];
    for (const payload of pending) {
      window.showPermissionDialog?.(payload);
    }
  }

  window.showAskUserQuestionDialog = (json) => {
    try {
      const request = JSON.parse(json);
      openAskUserQuestionDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse ask user question request:', error);
    }
  };

  if (
    Array.isArray(window.__pendingAskUserQuestionDialogRequests) &&
    window.__pendingAskUserQuestionDialogRequests.length > 0
  ) {
    const pending = window.__pendingAskUserQuestionDialogRequests.slice();
    window.__pendingAskUserQuestionDialogRequests = [];
    for (const payload of pending) {
      window.showAskUserQuestionDialog?.(payload);
    }
  }

  window.showPlanApprovalDialog = (json) => {
    try {
      const request = JSON.parse(json);
      openPlanApprovalDialog(request);
    } catch (error) {
      console.error('[Frontend] Failed to parse plan approval request:', error);
    }
  };

  if (
    Array.isArray(window.__pendingPlanApprovalDialogRequests) &&
    window.__pendingPlanApprovalDialogRequests.length > 0
  ) {
    const pending = window.__pendingPlanApprovalDialogRequests.slice();
    window.__pendingPlanApprovalDialogRequests = [];
    for (const payload of pending) {
      window.showPlanApprovalDialog?.(payload);
    }
  }
}
