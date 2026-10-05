/**
 * 情报站的终端：研究任务的输出（接口请求、弹幕统计、字幕、转写进度条、LLM 分析）原样滚动显示。
 * 这就是她的「感官」：她不是在看视频，是在读这些数据。
 */

import type { ResearchLogLine } from '../../shared/types/live';

const MAX_LINES = 14;

interface Row {
  id?: string;
  text: string;
}

const rows: Row[] = [];

function kind(text: string): string {
  if (text.startsWith('────')) return 'rule';
  if (/^\[(skip|fail|wait)\]/.test(text) || /失败|没装|跳过/.test(text)) return 'warn';
  if (/^\[(save|report|sub)\]/.test(text)) return 'good';
  if (/^\[llm\]/.test(text)) return 'llm';
  return '';
}

function render(): void {
  const box = document.getElementById('term-lines');
  if (!box) return;
  box.replaceChildren(...rows.map((row, i) => {
    const line = document.createElement('div');
    line.className = `term-line ${kind(row.text)}`;
    const tag = /^\[[a-z]+\]/.exec(row.text)?.[0];
    if (tag) {
      const t = document.createElement('span');
      t.className = 'tag';
      t.textContent = tag;
      line.append(t, document.createTextNode(row.text.slice(tag.length)));
    } else {
      line.textContent = row.text;
    }
    if (i === rows.length - 1) line.classList.add('term-cursor');
    return line;
  }));
}

function push(line: ResearchLogLine): void {
  const text = line.text.replace(/\s+$/, '');
  // 同 id 的行原地更新（转写进度条）
  const existing = line.id ? rows.find((r) => r.id === line.id) : undefined;
  if (existing) existing.text = text;
  else rows.push({ id: line.id, text });
  while (rows.length > MAX_LINES) rows.shift();
  render();
}

export function initStageTerminal(): void {
  window.liveAPI?.onTerminal?.(push);
  push({ text: 'hiyori@bili-intel:~$ ' });
}
