import { describe, expect, it } from 'vitest';
import { formatFeishuCommandHelp, parseFeishuCommand } from '../feishuCommands';

describe('Feishu bridge commands', () => {
  it('parses voice reply commands', () => {
    expect(parseFeishuCommand('/h')).toBe('help');
    expect(parseFeishuCommand('/startvoice')).toBe('startvoice');
    expect(parseFeishuCommand('/STOPVOICE')).toBe('stopvoice');
    expect(parseFeishuCommand('hello')).toBeNull();
  });

  it('formats command help with current voice state', () => {
    expect(formatFeishuCommandHelp(true)).toContain('voice: on');
    expect(formatFeishuCommandHelp(false)).toContain('/startvoice');
    expect(formatFeishuCommandHelp(false)).toContain('/stopvoice');
  });
});
