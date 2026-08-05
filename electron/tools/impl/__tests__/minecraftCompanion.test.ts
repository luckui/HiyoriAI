import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToolset } from '../../../toolsets';

const command = vi.fn();
const startCollection = vi.fn();
const rememberOrigin = vi.fn();
const discoverLanRooms = vi.fn();

vi.mock('../../../minecraft', () => ({
  minecraftRuntime: { command, startCollection, rememberOrigin },
  discoverLanRooms,
}));

vi.mock('../../../bridges/asyncDelivery', () => ({
  getReplyTargetForConversation: vi.fn(() => ({ kind: 'desktop' })),
}));

const { default: minecraftCompanionTool } = await import('../minecraftCompanion');

describe('minecraft_companion tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is available to the main Hiyori modes but not workers', () => {
    expect(resolveToolset('chat')).toContain('minecraft_companion');
    expect(resolveToolset('agent')).toContain('minecraft_companion');
    expect(resolveToolset('agent-debug')).toContain('minecraft_companion');
    expect(resolveToolset('worker')).not.toContain('minecraft_companion');
  });

  it('asks the user to open or choose a LAN room when discovery is not singular', async () => {
    discoverLanRooms.mockResolvedValueOnce([]);
    await expect(
      minecraftCompanionTool.execute({ action: 'connect' }, { conversationId: 'c1' }),
    ).resolves.toContain('请先在 Minecraft Java 世界中开启“对局域网开放”');
    expect(command).not.toHaveBeenCalled();

    discoverLanRooms.mockResolvedValueOnce([
      { motd: 'One', host: '127.0.0.1', advertisedHost: 'x', port: 60131 },
      { motd: 'Two', host: '192.168.1.2', advertisedHost: 'y', port: 60132 },
    ]);
    const result = await minecraftCompanionTool.execute(
      { action: 'connect' },
      { conversationId: 'c1' },
    );
    expect(result).toContain('需要用户选择');
    expect(result).toContain('1. One');
    expect(result).toContain('2. Two');
    expect(command).not.toHaveBeenCalled();
  });

  it('automatically connects the only discovered room', async () => {
    discoverLanRooms.mockResolvedValueOnce([
      { motd: 'Home', host: '127.0.0.1', advertisedHost: 'x', port: 60131 },
    ]);
    command.mockResolvedValueOnce({ connected: true, players: ['GeoLingua'] });

    const result = await minecraftCompanionTool.execute(
      { action: 'connect' },
      { conversationId: 'c1' },
    );

    expect(command).toHaveBeenCalledWith('connect', {
      host: '127.0.0.1',
      port: 60131,
      username: 'Hiyori',
      owner: undefined,
    });
    expect(result).toContain('已加入 Minecraft 房间');
    expect(rememberOrigin).toHaveBeenCalled();
  });

  it('accepts collection once and does not instruct Hiyori to poll', async () => {
    startCollection.mockResolvedValueOnce({
      state: 'running',
      jobId: 'job-1',
      block: 'oak_log',
      quantity: 12,
      radius: 32,
    });

    const result = await minecraftCompanionTool.execute(
      { action: 'collect', block: 'oak_log', quantity: 12 },
      { conversationId: 'c1' },
    );

    expect(result).toContain('正在执行');
    expect(result).toContain('完成后会自动带回结果');
    expect(result).not.toContain('查询状态');
    expect(result).not.toContain('轮询');
  });
});
