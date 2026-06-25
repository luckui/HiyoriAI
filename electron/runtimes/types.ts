export type RuntimeSessionStatus =
  | 'starting'
  | 'running'
  | 'waiting_for_input'
  | 'completed'
  | 'failed'
  | 'interrupted'
  | 'stopped';

export type RuntimeEventType =
  | 'session_started'
  | 'assistant_delta'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'approval_requested'
  | 'waiting_for_input'
  | 'notification'
  | 'completed'
  | 'failed'
  | 'interrupted';

export interface RuntimeAvailability {
  available: boolean;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeSession {
  id: string;
  providerId: string;
  providerSessionRef: string;
  hiyoriConversationId: string;
  cwd?: string;
  title: string;
  status: RuntimeSessionStatus;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

export interface StartRuntimeSessionInput {
  providerId: string;
  hiyoriConversationId: string;
  title: string;
  initialMessage: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface ResumeRuntimeSessionInput {
  providerId: string;
  runtimeSessionId: string;
  hiyoriConversationId: string;
  title: string;
  cwd?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeUserMessage {
  content: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeEvent {
  id: string;
  sessionId: string;
  providerId: string;
  type: RuntimeEventType;
  content: string;
  createdAt: number;
  raw?: Record<string, unknown>;
}

export interface RuntimeSubscription {
  unsubscribe(): void;
}

export interface AgentRuntimeProvider {
  id: string;
  displayName: string;
  checkAvailability(): Promise<RuntimeAvailability>;
  startSession(input: StartRuntimeSessionInput): Promise<RuntimeSession>;
  resumeSession(input: ResumeRuntimeSessionInput): Promise<RuntimeSession>;
  sendMessage(sessionId: string, message: RuntimeUserMessage): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  stop(sessionId: string): Promise<void>;
  subscribe(sessionId: string, onEvent: (event: RuntimeEvent) => void): RuntimeSubscription;
}

export interface RuntimeProviderSummary {
  id: string;
  displayName: string;
}
