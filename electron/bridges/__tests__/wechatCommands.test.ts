import { describe, expect, it } from 'vitest';
import { formatWeChatCommandHelp, parseWeChatCommand } from '../wechatCommands';

describe('WeChat bridge commands', () => {
  it('parses voice reply commands before normal AI chat handling', () => {
    expect(parseWeChatCommand('/h')).toBe('help');
    expect(parseWeChatCommand(' /startvoice ')).toBe('startvoice');
    expect(parseWeChatCommand('/STOPVOICE')).toBe('stopvoice');
    expect(parseWeChatCommand('/hello')).toBeNull();
    expect(parseWeChatCommand('please /stopvoice')).toBeNull();
  });

  it('formats a compact command help with current voice reply status', () => {
    expect(formatWeChatCommandHelp(true)).toContain('/stopvoice');
    expect(formatWeChatCommandHelp(false)).toContain('/startvoice');
    expect(formatWeChatCommandHelp(true)).toContain('on');
    expect(formatWeChatCommandHelp(false)).toContain('off');
  });
});
