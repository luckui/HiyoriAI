import { describe, expect, it, vi } from 'vitest';
import {
  discoverLanRooms,
  parseLanAnnouncement,
  type LanAnnouncement,
} from '../lanDiscovery';

describe('parseLanAnnouncement', () => {
  it('parses a valid Minecraft LAN announcement', () => {
    expect(
      parseLanAnnouncement(
        '[MOTD]GeoLingua - test[/MOTD][AD]60131[/AD]',
        '49.52.30.20',
      ),
    ).toEqual({
      motd: 'GeoLingua - test',
      advertisedHost: '49.52.30.20',
      port: 60131,
    });
  });

  it('rejects malformed announcements and invalid ports', () => {
    expect(parseLanAnnouncement('invalid', '127.0.0.1')).toBeNull();
    expect(
      parseLanAnnouncement('[MOTD]x[/MOTD][AD]70000[/AD]', '127.0.0.1'),
    ).toBeNull();
  });
});

describe('discoverLanRooms', () => {
  it('prefers localhost, deduplicates rooms, and preserves multiple choices', async () => {
    const announcements: LanAnnouncement[] = [
      {
        message: '[MOTD]First[/MOTD][AD]60131[/AD]',
        sourceAddress: '49.52.30.20',
      },
      {
        message: '[MOTD]Duplicate[/MOTD][AD]60131[/AD]',
        sourceAddress: '192.168.1.10',
      },
      {
        message: '[MOTD]Second[/MOTD][AD]60132[/AD]',
        sourceAddress: '192.168.1.11',
      },
    ];
    const probe = vi.fn(async (host: string, port: number) => {
      return (
        (host === '127.0.0.1' && port === 60131) ||
        (host === '192.168.1.11' && port === 60132)
      );
    });

    const rooms = await discoverLanRooms({
      listen: async () => announcements,
      probe,
    });

    expect(rooms).toEqual([
      {
        motd: 'First',
        advertisedHost: '49.52.30.20',
        host: '127.0.0.1',
        port: 60131,
      },
      {
        motd: 'Second',
        advertisedHost: '192.168.1.11',
        host: '192.168.1.11',
        port: 60132,
      },
    ]);
    expect(probe.mock.calls).toEqual([
      ['127.0.0.1', 60131],
      ['127.0.0.1', 60132],
      ['192.168.1.11', 60132],
    ]);
  });
});
