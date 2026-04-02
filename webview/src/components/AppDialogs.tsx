import { type ComponentProps } from 'react';
import type { TFunction } from 'i18next';
import ConfirmDialog from './ConfirmDialog';
import PermissionDialog from './PermissionDialog';
import AskUserQuestionDialog from './AskUserQuestionDialog';
import PlanApprovalDialog from './PlanApprovalDialog';
import RewindDialog from './RewindDialog';
import RewindSelectDialog, { type RewindableMessage } from './RewindSelectDialog';
import ChangelogDialog from './ChangelogDialog';
import CustomModelDialog from './settings/CustomModelDialog';
import { usePluginModels } from './settings/hooks/usePluginModels';
import { STORAGE_KEYS } from '../types/provider';
import { CHANGELOG_DATA } from '../version/changelog';

/**
 * Wrapper that manages plugin-level custom models for the add-model dialog.
 * Uses the shared usePluginModels hook for localStorage persistence.
 */
const AddModelDialogWrapper = ({
  isOpen,
  onClose,
  currentProvider,
}: {
  isOpen: boolean;
  onClose: () => void;
  currentProvider: string;
}) => {
  const storageKey = currentProvider === 'codex'
    ? STORAGE_KEYS.CODEX_CUSTOM_MODELS
    : STORAGE_KEYS.CLAUDE_CUSTOM_MODELS;
  const { models, updateModels } = usePluginModels(storageKey);
  return (
    <CustomModelDialog
      isOpen={isOpen}
      models={models}
      onModelsChange={updateModels}
      onClose={onClose}
      initialAddMode
    />
  );
};

export interface AppDialogsProps {
  t: TFunction;
  showNewSessionConfirm: boolean;
  onConfirmNewSession: () => void;
  onCancelNewSession: () => void;
  showInterruptConfirm: boolean;
  onConfirmInterrupt: () => void;
  onCancelInterrupt: () => void;
  permissionDialogOpen: boolean;
  currentPermissionRequest: ComponentProps<typeof PermissionDialog>['request'];
  onPermissionApprove: ComponentProps<typeof PermissionDialog>['onApprove'];
  onPermissionSkip: ComponentProps<typeof PermissionDialog>['onSkip'];
  onPermissionApproveAlways: ComponentProps<typeof PermissionDialog>['onApproveAlways'];
  askUserQuestionDialogOpen: boolean;
  currentAskUserQuestionRequest: ComponentProps<typeof AskUserQuestionDialog>['request'];
  onAskUserQuestionSubmit: ComponentProps<typeof AskUserQuestionDialog>['onSubmit'];
  onAskUserQuestionCancel: ComponentProps<typeof AskUserQuestionDialog>['onCancel'];
  planApprovalDialogOpen: boolean;
  currentPlanApprovalRequest: ComponentProps<typeof PlanApprovalDialog>['request'];
  onPlanApprovalApprove: ComponentProps<typeof PlanApprovalDialog>['onApprove'];
  onPlanApprovalReject: ComponentProps<typeof PlanApprovalDialog>['onReject'];
  rewindSelectDialogOpen: boolean;
  rewindableMessages: RewindableMessage[];
  onRewindSelect: ComponentProps<typeof RewindSelectDialog>['onSelect'];
  onRewindSelectCancel: ComponentProps<typeof RewindSelectDialog>['onCancel'];
  rewindDialogOpen: boolean;
  currentRewindRequest: ComponentProps<typeof RewindDialog>['request'];
  isRewinding: boolean;
  onRewindConfirm: ComponentProps<typeof RewindDialog>['onConfirm'];
  onRewindCancel: ComponentProps<typeof RewindDialog>['onCancel'];
  showChangelogDialog: boolean;
  onCloseChangelog: () => void;
  addModelDialogOpen: boolean;
  onCloseAddModel: () => void;
  currentProvider: string;
}

export const AppDialogs = (props: AppDialogsProps) => (
  <>
    <ConfirmDialog
      isOpen={props.showNewSessionConfirm}
      title={props.t('chat.createNewSession')}
      message={props.t('chat.confirmNewSession')}
      confirmText={props.t('common.confirm')}
      cancelText={props.t('common.cancel')}
      onConfirm={props.onConfirmNewSession}
      onCancel={props.onCancelNewSession}
    />
    <ConfirmDialog
      isOpen={props.showInterruptConfirm}
      title={props.t('chat.createNewSession')}
      message={props.t('chat.confirmInterrupt')}
      confirmText={props.t('common.confirm')}
      cancelText={props.t('common.cancel')}
      onConfirm={props.onConfirmInterrupt}
      onCancel={props.onCancelInterrupt}
    />
    <PermissionDialog
      isOpen={props.permissionDialogOpen}
      request={props.currentPermissionRequest}
      onApprove={props.onPermissionApprove}
      onSkip={props.onPermissionSkip}
      onApproveAlways={props.onPermissionApproveAlways}
    />
    <AskUserQuestionDialog
      isOpen={props.askUserQuestionDialogOpen}
      request={props.currentAskUserQuestionRequest}
      onSubmit={props.onAskUserQuestionSubmit}
      onCancel={props.onAskUserQuestionCancel}
    />
    <PlanApprovalDialog
      isOpen={props.planApprovalDialogOpen}
      request={props.currentPlanApprovalRequest}
      onApprove={props.onPlanApprovalApprove}
      onReject={props.onPlanApprovalReject}
    />
    <RewindSelectDialog
      isOpen={props.rewindSelectDialogOpen}
      rewindableMessages={props.rewindableMessages}
      onSelect={props.onRewindSelect}
      onCancel={props.onRewindSelectCancel}
    />
    <RewindDialog
      isOpen={props.rewindDialogOpen}
      request={props.currentRewindRequest}
      isLoading={props.isRewinding}
      onConfirm={props.onRewindConfirm}
      onCancel={props.onRewindCancel}
    />
    <ChangelogDialog
      isOpen={props.showChangelogDialog}
      onClose={props.onCloseChangelog}
      entries={CHANGELOG_DATA}
    />
    <AddModelDialogWrapper
      isOpen={props.addModelDialogOpen}
      onClose={props.onCloseAddModel}
      currentProvider={props.currentProvider}
    />
  </>
);
