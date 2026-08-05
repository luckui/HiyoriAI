import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToolset } from '../../../toolsets';

const command = vi.fn();
const rememberOrigin = vi.fn();
const discoverLanRooms = vi.fn();
const startGoal = vi.fn(async () => undefined);
const stopGoal = vi.fn(async () => true);

vi.mock('../../../minecraft', () => ({
  minecraftRuntime: { command, rememberOrigin },
  getMinecraftGoalCoordinator: vi.fn(() => ({ startGoal, stopGoal })),
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

  it('starts a natural-language goal instead of exposing collect and follow choices', async () => {
    const result = await minecraftCompanionTool.execute(
      { action: 'start_goal', task: '帮我采附近的甘蔗' },
      { conversationId: 'c1' },
    );

    expect(startGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Minecraft 目标',
        instruction: '帮我采附近的甘蔗',
        origin: expect.objectContaining({ conversationId: 'c1', source: 'desktop' }),
      }),
    );
    expect(result).toContain('已开始 Minecraft 目标');
    expect(result).toContain('完成或需要你决定时会主动告诉你');
  });

  it('stops the current natural-language goal for the conversation', async () => {
    const started = await minecraftCompanionTool.execute(
      { action: 'start_goal', task: '跟着我' },
      { conversationId: 'c1' },
    );
    const id = /目标 ID：([^\n]+)/.exec(String(started))?.[1]?.trim();
    expect(id).toBeTruthy();

    const stopped = await minecraftCompanionTool.execute(
      { action: 'stop_goal' },
      { conversationId: 'c1' },
    );

    expect(stopGoal).toHaveBeenCalledWith(id);
    expect(stopped).toContain('已请求停止 Minecraft 目标');
  });

  it('rejects obsolete low-level collect and follow actions with clear wording', async () => {
    const collect = await minecraftCompanionTool.execute(
      { action: 'collect', block: 'oak_log' } as never,
      { conversationId: 'c1' },
    );
    const follow = await minecraftCompanionTool.execute(
      { action: 'follow', player: 'GeoLingua' } as never,
      { conversationId: 'c1' },
    );

    expect(collect).toContain('请用 start_goal 描述想在 Minecraft 里完成的事情');
    expect(follow).toContain('请用 start_goal 描述想在 Minecraft 里完成的事情');
    expect(command).not.toHaveBeenCalledWith('follow', expect.anything());
  });
});
