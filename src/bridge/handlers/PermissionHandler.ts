import { BridgeHandler, BridgeMessage } from '../types';
import { PermissionIpcService } from '../services/PermissionIpcService';

export class PermissionHandler implements BridgeHandler {
  readonly supportedEvents = [
    'permission_decision',
    'ask_user_question_response',
    'plan_approval_response',
  ] as const;

  constructor(private readonly permissionIpc: PermissionIpcService) {}

  handle({ event, content }: BridgeMessage): boolean {
    switch (event) {
      case 'permission_decision':
        this.permissionIpc.handlePermissionDecision(content);
        return true;
      case 'ask_user_question_response':
        this.permissionIpc.handleAskUserQuestionResponse(content);
        return true;
      case 'plan_approval_response':
        this.permissionIpc.handlePlanApprovalResponse(content);
        return true;
      default:
        return false;
    }
  }
}
