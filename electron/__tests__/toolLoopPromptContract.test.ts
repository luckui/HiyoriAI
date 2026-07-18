import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('tool loop prompt contract', () => {
  it('does not inject hard continuation instructions after tool results', () => {
    const source = readFileSync(join(process.cwd(), 'electron', 'aiService.ts'), 'utf8');

    expect(source).toContain('【工具结果处理】');
    expect(source).toContain('要求“询问用户”时，提出问题并等待');
    expect(source).not.toContain('【系统强制】');
    expect(source).not.toContain('直接执行下一步操作');
    expect(source).not.toContain('禁止输出任何文字回复');
    expect(source).not.toContain('必须立刻调用');
  });
});
