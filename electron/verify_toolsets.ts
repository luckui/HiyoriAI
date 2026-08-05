/**
 * 工具分层验证脚本
 * 显示各模式下暴露的工具列表
 */

import { resolveToolset } from './toolsets';

const modes = ['chat', 'agent', 'agent-debug', 'developer'];

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('📊 工具分层方案验证\n');

for (const mode of modes) {
  const tools = resolveToolset(mode);
  console.log(`${mode.toUpperCase()} 模式 (${tools.length} 个工具):`);
  console.log(tools.sort().join(', '));
  console.log('');
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// 验证 chat 模式核心工具
const chatTools = resolveToolset('chat');
const requiredChatTools = [
  'memory',
  'todo',
  'read_skill',
  'run_command',
  'request_agent_mode',
  'browser_open',
  'browser_read_page',
  'browser_screenshot',
  'calculate',
  'get_current_datetime',
  'take_screenshot',
];

console.log('\n✅ Chat 模式核心工具验证:');
for (const tool of requiredChatTools) {
  const has = chatTools.includes(tool);
  console.log(`  ${has ? '✅' : '❌'} ${tool}`);
}

// 验证 agent 模式 Skills
const agentTools = resolveToolset('agent');
const requiredSkills = [
  'browser_open',
  'browser_click_smart',
  'browser_type_smart',
  'open_terminal',
  'write_file',
  'check_python_env',
  'discord_send_file',
];

console.log('\n✅ Agent 模式 Skills 验证:');
for (const skill of requiredSkills) {
  const has = agentTools.includes(skill);
  console.log(`  ${has ? '✅' : '❌'} ${skill}`);
}

// 验证 run_command 在所有模式都存在
console.log('\n⭐ run_command 核心工具验证:');
for (const mode of modes) {
  const tools = resolveToolset(mode);
  const has = tools.includes('run_command');
  console.log(`  ${has ? '✅' : '❌'} ${mode}: ${has ? 'run_command 已保留' : '缺失 run_command'}`);
}
