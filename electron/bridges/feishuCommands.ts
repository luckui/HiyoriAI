export type FeishuCommand = 'help' | 'startvoice' | 'stopvoice';

export function parseFeishuCommand(text: string): FeishuCommand | null {
  const normalized = text.trim().toLowerCase();
  if (normalized === '/h') return 'help';
  if (normalized === '/startvoice') return 'startvoice';
  if (normalized === '/stopvoice') return 'stopvoice';
  return null;
}

export function formatFeishuCommandHelp(voiceRepliesEnabled: boolean): string {
  const status = voiceRepliesEnabled ? 'on' : 'off';
  return [
    `Hiyori Lark / Feishu commands (voice: ${status})`,
    '/h - show this help',
    '/startvoice - enable voice bubble replies',
    '/stopvoice - disable voice bubble replies',
  ].join('\n');
}
