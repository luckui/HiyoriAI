export type WeChatCommand = 'help' | 'startvoice' | 'stopvoice';

export function parseWeChatCommand(text: string): WeChatCommand | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === '/h') return 'help';
  if (normalized === '/startvoice') return 'startvoice';
  if (normalized === '/stopvoice') return 'stopvoice';
  return null;
}

export function formatWeChatCommandHelp(voiceRepliesEnabled: boolean): string {
  const status = voiceRepliesEnabled ? 'on' : 'off';
  return [
    `Hiyori WeChat commands (voice: ${status})`,
    '/h - show this help',
    '/startvoice - enable voice file replies',
    '/stopvoice - disable voice file replies',
  ].join('\n');
}
