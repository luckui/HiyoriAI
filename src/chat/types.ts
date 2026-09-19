// 聊天界面用到的数据类型与 preload 暴露的 API（与 electron/preload.ts 保持一致）

export interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  preview: string;
}

export interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
}

declare global {
  interface Window {
    electronAPI?: {
      dragWindow: (dx: number, dy: number) => void;
      closeWindow: () => void;
      resizeWindow: (width: number, height: number) => void;
      togglePin: () => void;
      onPinState: (cb: (pinned: boolean) => void) => void;
    };
    chatAPI?: {
      createConversation(): Promise<Conversation>;
      listConversations(): Promise<Conversation[]>;
      loadConversation(id: string): Promise<ChatMessage[]>;
      deleteConversation(id: string): Promise<void>;
      renameConversation(id: string, title: string): Promise<void>;
      send(conversationId: string, content: string, replyTarget?: unknown, requestContext?: unknown): Promise<{ content: string; created_at: number; turnId?: string }>;
      stopAI?(): Promise<void>;
      /** 监听 background/batch 任务完成后的主对话 AI 唤醒（触发新轮工作流） */
      onWakeup?(cb: (payload: { conversationId: string; text: string; replyTarget?: unknown; trigger?: unknown }) => void): () => void;
      onExternalTurn?(cb: (payload: {
        conversationId: string;
        user: string;
        assistant: string;
        createdAt: number;
      }) => void): () => void;
    };
    appLifecycleAPI?: {
      onQuitting(cb: () => void): void;
      onQuitReady(cb: () => void): void;
    };
    debugAPI?: {
      onToolCall(cb: (ev: {
        name: string;
        args: Record<string, unknown>;
        result: string;
        ok: boolean;
        durationMs: number;
      }) => void): void;
    };
    ttsAPI?: {
      isEnabled(): Promise<boolean>;
      health(): Promise<{ ok: boolean; error?: string }>;
      speak(text: string): Promise<{ data: string } | null>;
    };
    agentAPI?: {
      getMode(): Promise<string>;
      setMode(mode: string): Promise<void>;
      onModeChanged(cb: (mode: string) => void): void;
    };
  }
}

export interface WakeupPayload {
  conversationId: string;
  text: string;
  replyTarget?: unknown;
  trigger?: unknown;
}
