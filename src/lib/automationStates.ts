// Automation Rule States
export enum AutomationRuleState {
  ACTIVE = 'ACTIVE',
  INACTIVE = 'INACTIVE',
  PAUSED = 'PAUSED',
  ARCHIVED = 'ARCHIVED',
  ERROR = 'ERROR'
}

// Scheduled Job States
export enum ScheduledJobState {
  SCHEDULED = 'SCHEDULED',
  RUNNING = 'RUNNING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  PAUSED = 'PAUSED',
  CANCELLED = 'CANCELLED'
}

// Notification States
export enum NotificationState {
  PENDING = 'PENDING',
  SENT = 'SENT',
  FAILED = 'FAILED',
  READ = 'READ',
  ARCHIVED = 'ARCHIVED'
}

// Event States
export enum EventState {
  CREATED = 'CREATED',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  RETRYING = 'RETRYING'
}

// Automation Rule Trigger Types
export enum AutomationTriggerType {
  MANUAL = 'MANUAL',
  SCHEDULED = 'SCHEDULED',
  EVENT_BASED = 'EVENT_BASED',
  WEBHOOK = 'WEBHOOK',
  API = 'API'
}

// Automation Rule Action Types
export enum AutomationActionType {
  CREATE_PO = 'CREATE_PO',
  SEND_EMAIL = 'SEND_EMAIL',
  UPDATE_INVENTORY = 'UPDATE_INVENTORY',
  CREATE_ALERT = 'CREATE_ALERT',
  RUN_REPORT = 'RUN_REPORT',
  WEBHOOK_CALL = 'WEBHOOK_CALL',
  CUSTOM_SCRIPT = 'CUSTOM_SCRIPT'
}

// State transition rules
export const StateTransitions: Record<AutomationRuleState, AutomationRuleState[]> = {
  [AutomationRuleState.ACTIVE]: [
    AutomationRuleState.PAUSED,
    AutomationRuleState.INACTIVE,
    AutomationRuleState.ERROR,
    AutomationRuleState.ARCHIVED
  ],
  [AutomationRuleState.INACTIVE]: [
    AutomationRuleState.ACTIVE,
    AutomationRuleState.ARCHIVED
  ],
  [AutomationRuleState.PAUSED]: [
    AutomationRuleState.ACTIVE,
    AutomationRuleState.INACTIVE,
    AutomationRuleState.ERROR
  ],
  [AutomationRuleState.ERROR]: [
    AutomationRuleState.ACTIVE,
    AutomationRuleState.PAUSED,
    AutomationRuleState.INACTIVE
  ],
  [AutomationRuleState.ARCHIVED]: []
};

export const JobStateTransitions: Record<ScheduledJobState, ScheduledJobState[]> = {
  [ScheduledJobState.SCHEDULED]: [
    ScheduledJobState.RUNNING,
    ScheduledJobState.CANCELLED
  ],
  [ScheduledJobState.RUNNING]: [
    ScheduledJobState.COMPLETED,
    ScheduledJobState.FAILED,
    ScheduledJobState.PAUSED
  ],
  [ScheduledJobState.PAUSED]: [
    ScheduledJobState.RUNNING,
    ScheduledJobState.CANCELLED
  ],
  [ScheduledJobState.COMPLETED]: [],
  [ScheduledJobState.FAILED]: [
    ScheduledJobState.SCHEDULED
  ],
  [ScheduledJobState.CANCELLED]: []
};

// State helper functions
export function canTransitionState(
  currentState: AutomationRuleState,
  targetState: AutomationRuleState
): boolean {
  return StateTransitions[currentState]?.includes(targetState) ?? false;
}

export function canTransitionJobState(
  currentState: ScheduledJobState,
  targetState: ScheduledJobState
): boolean {
  return JobStateTransitions[currentState]?.includes(targetState) ?? false;
}

export function getStateColor(state: AutomationRuleState | ScheduledJobState | NotificationState): string {
  switch (state) {
    case AutomationRuleState.ACTIVE:
    case ScheduledJobState.RUNNING:
    case ScheduledJobState.COMPLETED:
    case NotificationState.SENT:
      return 'text-green-400';

    case AutomationRuleState.PAUSED:
    case ScheduledJobState.PAUSED:
    case NotificationState.PENDING:
      return 'text-yellow-400';

    case AutomationRuleState.INACTIVE:
    case ScheduledJobState.CANCELLED:
    case NotificationState.ARCHIVED:
      return 'text-gray-400';

    case AutomationRuleState.ERROR:
    case ScheduledJobState.FAILED:
    case NotificationState.FAILED:
      return 'text-red-400';

    default:
      return 'text-on-surface-variant';
  }
}

export function getStateBgColor(state: AutomationRuleState | ScheduledJobState | NotificationState): string {
  switch (state) {
    case AutomationRuleState.ACTIVE:
    case ScheduledJobState.RUNNING:
    case ScheduledJobState.COMPLETED:
    case NotificationState.SENT:
      return 'bg-green-500/10';

    case AutomationRuleState.PAUSED:
    case ScheduledJobState.PAUSED:
    case NotificationState.PENDING:
      return 'bg-yellow-500/10';

    case AutomationRuleState.INACTIVE:
    case ScheduledJobState.CANCELLED:
    case NotificationState.ARCHIVED:
      return 'bg-gray-500/10';

    case AutomationRuleState.ERROR:
    case ScheduledJobState.FAILED:
    case NotificationState.FAILED:
      return 'bg-red-500/10';

    default:
      return 'bg-surface-container-high/30';
  }
}

export function getStateBorderColor(state: AutomationRuleState | ScheduledJobState | NotificationState): string {
  switch (state) {
    case AutomationRuleState.ACTIVE:
    case ScheduledJobState.RUNNING:
    case ScheduledJobState.COMPLETED:
    case NotificationState.SENT:
      return 'border-green-500/20';

    case AutomationRuleState.PAUSED:
    case ScheduledJobState.PAUSED:
    case NotificationState.PENDING:
      return 'border-yellow-500/20';

    case AutomationRuleState.INACTIVE:
    case ScheduledJobState.CANCELLED:
    case NotificationState.ARCHIVED:
      return 'border-gray-500/20';

    case AutomationRuleState.ERROR:
    case ScheduledJobState.FAILED:
    case NotificationState.FAILED:
      return 'border-red-500/20';

    default:
      return 'border-outline-variant';
  }
}

export function getStateLabel(state: AutomationRuleState | ScheduledJobState | NotificationState | EventState): string {
  return state
    .split('_')
    .map(word => word.charAt(0) + word.slice(1).toLowerCase())
    .join(' ');
}
