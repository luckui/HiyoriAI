import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '../tools/types';

const userData = mkdtempSync(join(tmpdir(), 'hiyori-wakeup-test-'));
const fetchCompletionMock = vi.hoisted(() => vi.fn());
const messagesByConversation = vi.hoisted(() => new Map<string, Array<{
  conversation_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}>>());
const settings = vi.hoisted(() => new Map<string, string>());

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    on: vi.fn(),
    whenReady: vi.fn(() => Promise.resolve()),
    getAppPath: () => process.cwd(),
    getPath: () => userData,
  },
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('../llmClient', () => ({
  fetchCompletion: fetchCompletionMock,
}));

vi.mock('../db', () => ({
  addMessage: vi.fn((message: { conversation_id: string; role: 'user' | 'assistant'; content: string }) => {
    const saved = { ...message, created_at: Date.now() };
    const current = messagesByConversation.get(message.conversation_id) ?? [];
    current.push(saved);
    messagesByConversation.set(message.conversation_id, current);
    return saved;
  }),
  getRecentContext: vi.fn((conversationId: string) => messagesByConversation.get(conversationId) ?? []),
  getMessages: vi.fn((conversationId: string) => messagesByConversation.get(conversationId) ?? []),
  renameConversation: vi.fn(),
  getSetting: vi.fn((key: string) => settings.get(key) ?? null),
  setSetting: vi.fn((key: string, value: string) => {
    settings.set(key, value);
  }),
  getMemoryFragments: vi.fn(() => []),
  addMemoryFragment: vi.fn(),
  countNonSystemMessages: vi.fn(() => 0),
  getMessagesInRange: vi.fn(() => []),
  getMemoryCursor: vi.fn(() => 0),
  setMemoryCursor: vi.fn(),
  getStructuredGlobalMemory: vi.fn(() => ({ user: [], memory: [] })),
  setStructuredGlobalMemory: vi.fn(),
  getGlobalMemoryCursor: vi.fn(() => 0),
  setGlobalMemoryCursor: vi.fn(),
}));

vi.mock('../main', () => ({
  getTTSConfig: vi.fn(() => ({
    enabled: false,
    activeProvider: 'local_edge_tts',
    providers: {
      local_edge_tts: {
        name: 'Edge TTS',
        isLocal: true,
        localEngine: 'edge-tts',
        baseUrl: 'http://localhost:5050',
      },
    },
  })),
  updateTTSConfig: vi.fn(),
}));

describe('async wakeup correction behavior', () => {
  beforeEach(() => {
    fetchCompletionMock.mockReset();
    messagesByConversation.clear();
    settings.clear();
  });

  it('does not inject task nudges or action correction for async result notifications', async () => {
    const { sendChatMessage } = await import('../aiService');
    const conversationId = 'async-wakeup-correction';
    const seenMessages: ChatMessage[][] = [];
    fetchCompletionMock.mockImplementation(async (_provider, messages: ChatMessage[]) => {
      seenMessages.push(messages);
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: 'Hi，Codex 已回复。' },
        }],
      };
    });

    const wakeup = [
      '【异步结果通知】',
      '来源：Codex 编程代理',
      '状态：已完成',
      '下一步：回复用户',
      '任务：连通性测试',
      '',
      '结果：',
      'Hi',
    ].join('\n');

    const result = await sendChatMessage(conversationId, wakeup);

    expect(result.content).toBe('Hi，Codex 已回复。');
    expect(fetchCompletionMock).toHaveBeenCalledTimes(1);
    const flattened = seenMessages[0].map((message) => (
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )).join('\n');
    expect(flattened).not.toContain('检测到用户可能在请求执行一项任务');
    expect(flattened).not.toContain('你刚才没有调用任何工具');
  });

  it('does not inject task nudges or action correction for scheduled reminder wakeups', async () => {
    const { sendChatMessage } = await import('../aiService');
    const conversationId = 'scheduled-reminder-wakeup-correction';
    const seenMessages: ChatMessage[][] = [];
    fetchCompletionMock.mockImplementation(async (_provider, messages: ChatMessage[]) => {
      seenMessages.push(messages);
      return {
        choices: [{
          finish_reason: 'stop',
          message: { content: '该继续上班啦，先把注意力拉回来，我们慢慢进入状态。' },
        }],
      };
    });

    const wakeup = [
      '【定时提醒】',
      '任务：继续上班提醒',
      '提醒指令：请提醒用户继续上班啦，该回到工作状态了。',
      '',
      '请直接向用户发出提醒或开启简短对话。除非提醒内容本身要求真实操作，否则不需要调用工具。',
    ].join('\n');

    const result = await sendChatMessage(conversationId, wakeup);

    expect(result.content).toBe('该继续上班啦，先把注意力拉回来，我们慢慢进入状态。');
    expect(fetchCompletionMock).toHaveBeenCalledTimes(1);
    const flattened = seenMessages[0].map((message) => (
      typeof message.content === 'string' ? message.content : JSON.stringify(message.content)
    )).join('\n');
    expect(flattened).not.toContain('检测到用户可能在请求执行一项任务');
    expect(flattened).not.toContain('你刚才没有调用任何工具');
  });
});
