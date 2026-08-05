import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendFile = vi.fn();
const sendText = vi.fn();

vi.mock('electron', () => ({
  desktopCapturer: {
    getSources: vi.fn(),
  },
  nativeImage: {
    createFromBuffer: vi.fn(),
  },
}));

vi.mock('../../../bridges/adapters/feishu', () => ({
  FeishuAdapter: {
    activeAdapter: {
      sendFile,
      sendText,
    },
  },
}));

const { default: feishuSendFileTool } = await import('../feishuSendFile');

describe('feishu_send_file tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends a known local file to a Feishu chat', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hiyori-feishu-send-file-test-'));
    const filePath = join(dir, 'report.txt');
    writeFileSync(filePath, 'hello');

    try {
      const result = await feishuSendFileTool.execute({
        chat_id: 'oc_chat',
        file_path: filePath,
        message: 'Here is the file',
      });

      expect(sendText).toHaveBeenCalledWith('oc_chat', 'Here is the file');
      expect(sendFile).toHaveBeenCalledWith('oc_chat', filePath);
      expect(String(result)).toContain('已向飞书会话 oc_chat 发送文件：report.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pauses when a requested file path does not exist', async () => {
    const result = await feishuSendFileTool.execute({
      chat_id: 'oc_chat',
      file_path: 'C:/not-found/missing.txt',
    });

    expect(typeof result).toBe('object');
    expect(result).toMatchObject({
      __pause: true,
    });
    expect(sendFile).not.toHaveBeenCalled();
  });
});
