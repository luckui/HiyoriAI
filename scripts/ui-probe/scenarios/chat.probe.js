// 聊天窗口：折叠/展开尺寸、对话列表、模式按钮循环、一次真实的发送（会调用当前 LLM）
// 发送在新建的临时对话里进行，结束后通过界面删除该对话
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = {};
  out.windowH0 = window.innerHeight;
  out.chatCollapsed0 = $('chat-body').classList.contains('collapsed');
  out.toggleIcon0 = $('toggle-icon').textContent;
  out.modeLabel0 = $('agent-mode-text').textContent;
  out.messagesOnBoot = $('messages').children.length > 0;

  // expand
  $('toggle-chat-btn').click();
  await sleep(700);
  out.expandedGrew = window.innerHeight - out.windowH0;
  out.chatCollapsedAfterExpand = $('chat-body').classList.contains('collapsed');
  out.toggleIconExpanded = $('toggle-icon').textContent;

  // conversation panel
  $('sessions-btn').click();
  await sleep(600);
  out.convPanelVisible = $('conv-panel').classList.contains('visible');
  out.convListed = $('conv-list').querySelectorAll('.conv-item').length > 0;
  $('sessions-btn').click();
  await sleep(200);
  out.convPanelClosed = !$('conv-panel').classList.contains('visible');

  // mode button: 5 clicks walk the whole cycle and land back on the start
  const seen = [];
  for (let i = 0; i < 5; i++) { $('agent-mode-btn').click(); await sleep(300); seen.push($('agent-mode-text').textContent); }
  out.modeCycle = seen.join('>');
  out.modeActive = $('agent-mode-btn').classList.contains('active');

  // scratch conversation: send one real message, then delete the conversation
  $('sessions-btn').click();
  await sleep(500);
  $('conv-new-btn').click();
  await sleep(900);
  out.panelClosedAfterNew = !$('conv-panel').classList.contains('visible');
  out.greetingShown = $('messages').textContent.includes('我是 Hiyori');
  out.titleForNew = $('chat-conv-title').textContent;
  const input = $('message-input');
  input.value = '只回复两个字：收到';
  $('send-btn').click();
  await sleep(150);
  out.stopModeWhileSending = $('send-btn').classList.contains('stop-mode');
  out.typingShown = !!document.querySelector('.typing-indicator');
  out.userBubble = [...document.querySelectorAll('#messages .user-message p')].some((p) => p.textContent === '只回复两个字：收到');
  out.inputCleared = input.value === '';
  for (let i = 0; i < 90 && $('send-btn').classList.contains('stop-mode'); i++) await sleep(500);
  out.buttonRestored = !$('send-btn').classList.contains('stop-mode');
  out.typingGone = !document.querySelector('.typing-indicator');
  const ai = [...document.querySelectorAll('#messages .ai-message .message-bubble p')].map((p) => p.textContent);
  out.aiReplied = ai.length >= 2 && !ai[ai.length - 1].startsWith('（出错了');
  out.emotionTagStripped = !ai[ai.length - 1].includes('[emotion:');
  out.inputFocused = document.activeElement === input;

  $('sessions-btn').click();
  await sleep(700);
  const active = document.querySelector('#conv-list .conv-item.active');
  const scratchId = active?.dataset.id;
  out.scratchActiveInList = !!active;
  active?.querySelector('.conv-item-delete')?.click();
  await sleep(1500);
  // 删除当前对话后列表不会重绘，直接问主进程
  out.scratchDeleted = !(await window.chatAPI.listConversations()).some((c) => c.id === scratchId);

  // collapse back
  if (!$('chat-body').classList.contains('collapsed')) $('toggle-chat-btn').click();
  await sleep(700);
  out.backToStartHeight = window.innerHeight === out.windowH0;
  out.convPanelClosedByCollapse = !$('conv-panel').classList.contains('visible');
  return out;
})()
