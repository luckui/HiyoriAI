/** header 上的 Agent 模式按钮：点击循环切换 chat → agent → agent-debug → developer → minecraft */

const MODE_CYCLE = ['chat', 'agent', 'agent-debug', 'developer', 'minecraft'] as const;
const MODE_LABELS: Record<string, string> = {
  chat: 'Chat',
  agent: 'Agent',
  'agent-debug': 'Debug',
  developer: 'Dev',
  minecraft: 'MC',
};

let currentMode = 'agent';

function render(mode: string): void {
  currentMode = mode;
  const text = document.getElementById('agent-mode-text');
  if (text) text.textContent = MODE_LABELS[mode] ?? 'Chat';
  // 高亮表示带工具的模式；chat 与不在循环里的模式（如直播 streamer）按 Chat 显示
  document.getElementById('agent-mode-btn')?.classList.toggle('active', mode in MODE_LABELS && mode !== 'chat');
}

export async function initAgentModeSwitch(): Promise<void> {
  // 以主进程的真实模式初始化，避免渲染器重载后显示错误状态
  render(await window.agentAPI?.getMode() ?? 'agent');

  document.getElementById('agent-mode-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const index = MODE_CYCLE.indexOf(currentMode as (typeof MODE_CYCLE)[number]);
    const next = index < 0 ? 'agent' : MODE_CYCLE[(index + 1) % MODE_CYCLE.length];
    await window.agentAPI?.setMode(next);
    console.log(`[Agent Mode] 用户切换到 ${next.toUpperCase()} 模式`);
    render(next);
  });

  // AI 通过 switch_agent_mode 工具切换模式时同步按钮
  window.agentAPI?.onModeChanged((mode) => {
    console.log(`[Agent Mode] AI 切换到 ${mode.toUpperCase()} 模式`);
    render(mode);
  });
}
