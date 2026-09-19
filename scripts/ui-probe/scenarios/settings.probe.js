// 设置面板：各分区加载、未保存修改的标记 / 确认 / 还原、密码显示切换、保存
// 注意：最后会点一次 LLM 的保存（内容未改动）
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (id) => document.getElementById(id);
  const out = {};
  $('settings-btn').click();
  await sleep(2500);
  out.panelVisible = $('settings-panel').classList.contains('visible');
  out.llmProviders = $('s-provider-select').options.length;
  out.llmName = $('s-name').value;
  out.llmRounds = $('s-rounds').value;
  out.llmDeleteHidden = $('s-del-btn').style.visibility;
  out.ttsProviders = $('tts-provider-select').options.length;
  out.ttsEnabled = $('tts-enabled').checked;
  out.ttsName = $('tts-name').value;
  out.ttsNameReadOnly = $('tts-name').readOnly;
  out.ttsRuntime = $('tts-runtime-text').textContent;
  out.ttsLocalVisible = $('tts-local-section').style.display;
  out.discordStatus = $('dc-status-text').textContent;
  out.feishuStatus = $('fs-status-text').textContent;
  out.wechatStatus = $('wc-status-text').textContent;
  out.wechatQrVisible = $('wc-qr-section').style.display;
  out.skillsSections = $('skills-mgr').querySelectorAll('section').length;
  out.dirtyAfterLoad = $('settings-panel').classList.contains('settings-dirty');

  // password toggle
  $('s-eye-btn').click();
  out.eyeRevealed = $('s-apiKey').type;
  $('s-eye-btn').click();
  out.eyeHidden = $('s-apiKey').type;

  // edit → dirty → switch tab → discard → reverted
  const temp = $('s-temp');
  const originalTemp = temp.value;
  temp.value = '1.23';
  temp.dispatchEvent(new Event('input'));
  out.dirtyAfterEdit = $('settings-panel').classList.contains('settings-dirty');
  document.querySelector('.s-tab[data-tab="tts"]').click();
  await sleep(300);
  out.dialogOnSwitch = $('settings-unsaved-dialog').classList.contains('visible');
  $('settings-unsaved-discard').click();
  await sleep(1500);
  out.tabAfterDiscard = document.querySelector('.s-tab.s-tab-active')?.dataset.tab;
  out.tempRestored = $('s-temp').value === originalTemp;
  out.dirtyAfterDiscard = $('settings-panel').classList.contains('settings-dirty');

  // bridge pane switch without edits: no dialog
  document.querySelector('.s-tab[data-tab="bridges"]').click();
  await sleep(200);
  document.querySelector('.s-bridge-item[data-bridge="wechat"]').click();
  await sleep(200);
  out.wechatPaneShown = !$('s-bridge-wechat').classList.contains('s-bridge-pane-hidden');

  // skills toggle marks dirty; close → dialog → discard
  document.querySelector('.s-tab[data-tab="skills"]').click();
  await sleep(200);
  const skillBox = $('skills-mgr').querySelector('.skills-item input');
  if (skillBox) { skillBox.click(); }
  out.dirtyAfterSkillToggle = $('settings-panel').classList.contains('settings-dirty');
  $('settings-back').click();
  await sleep(300);
  out.dialogOnClose = $('settings-unsaved-dialog').classList.contains('visible');
  $('settings-unsaved-discard').click();
  await sleep(1500);
  out.panelClosed = !$('settings-panel').classList.contains('visible');

  // reopen: LLM save button round-trip (saves unchanged config)
  $('settings-btn').click();
  await sleep(2000);
  document.querySelector('.s-tab[data-tab="llm"]').click();
  await sleep(200);
  $('settings-save-btn').click();
  await sleep(500);
  out.llmSaveLabel = $('settings-save-btn').textContent;
  $('settings-back').click();
  await sleep(300);
  out.closedWithoutDialog = !$('settings-unsaved-dialog').classList.contains('visible') && !$('settings-panel').classList.contains('visible');
  return out;
})()
