import { describe, expect, it } from 'vitest';
import { normalizeSpokenText, splitSpokenText } from '../spokenText';

const sample = `来啦～ 📊 这台电脑上一共有 **16 个 Codex 项目/工作区**，按最近活动给你列前 8 个：

1. **live2d-pet**
   路径：D:\\Other\\Live2dWeb\\live2d-pet
   任务：2 个 | 最近：live2d主线开发

2. **东京大学试题**
   路径：C:\\Users\\PC\\Documents\\Codex\\2026-07-29\\d-school-tokyo-logics-and-mathematics
   任务：1 个 | 最近：刚完成测试

5. **调教UTAU**
   任务：1 个 | 最近：2026/8/4 15:09`;

describe('spoken text normalizer', () => {
  it('turns structured mixed-language markdown into Chinese speech text', () => {
    const spoken = normalizeSpokenText(sample, { language: 'zh' });

    expect(spoken).toContain('这台电脑上一共有 16 个 Codex 项目或工作区');
    expect(spoken).toContain('第一项，live2d-pet。');
    expect(spoken).toContain('任务：2 个，最近：live2d主线开发。');
    expect(spoken).toContain('第五项，调教UTAU。');
    expect(spoken).toContain('2026年8月4日15点09分');
    expect(spoken).not.toContain('D:\\Other');
    expect(spoken).not.toContain('C:\\Users');
    expect(spoken).not.toContain('**');
    expect(spoken).not.toContain('|');
  });

  it('uses English date and list wording when the TTS language is English', () => {
    const spoken = normalizeSpokenText('1. **Project**\n最近：2026/8/4 15:09', { language: 'en' });

    expect(spoken).toContain('Item 1, Project.');
    expect(spoken).toContain('August 4, 2026 at 15:09');
    expect(spoken).not.toContain('2026年');
  });

  it('uses Japanese date and list wording when the TTS language is Japanese', () => {
    const spoken = normalizeSpokenText('1. **プロジェクト**\n最近：2026/8/4 15:09', { language: 'ja' });

    expect(spoken).toContain('1番目、プロジェクト。');
    expect(spoken).toContain('2026年8月4日15時09分');
  });

  it('splits normalized speech without treating numbered list dots as sentence ends', () => {
    const sentences = splitSpokenText(normalizeSpokenText(sample, { language: 'zh' }), {
      maxSegments: 8,
      maxSentenceLength: 120,
    });

    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.join('\n')).not.toContain('1.');
    expect(sentences.join('\n')).not.toContain('2.');
  });
});
