export function isAsyncResultNotification(userText: string): boolean {
  return userText.trimStart().startsWith('【异步结果通知】');
}

export function isScheduledReminderWakeup(userText: string): boolean {
  return userText.trimStart().startsWith('【定时提醒】');
}

export function isSystemWakeupNotification(userText: string): boolean {
  return isAsyncResultNotification(userText) || isScheduledReminderWakeup(userText);
}

export function isLikelyActionIntentText(userText: string): boolean {
  const t = userText.toLowerCase();
  if (!t) return false;
  return /(帮我|我要|请你|帮|打开|进入|访问|导航|搜索|点击|查看|看看|点开|执行|运行|截图|截屏|终端|cmd|powershell|命令|操作|控制|输入|填写|登录|登陆|提交|发布|发送|下载|上传|刷新|切换|关闭|退出|删除|复制|粘贴)/i.test(t);
}

export function isLikelyTaskRequestText(userText: string): boolean {
  if (/^(好的|嗯|谢谢|谢|ok|好|是的|对|不了|没事|算了|随便)[\s。！？]*$/i.test(userText.trim())) return false;
  return /(请|帮|查|找|看|给|写|改|删|开|关|装|跑|执行|运行|搜|列|显示|告诉我|能不能|可以吗|帮我|帮忙|需要你)/i.test(userText);
}

export function shouldApplyActionCorrection(userText: string): boolean {
  void userText;
  return false;
}

export function shouldApplyTaskIntentNudge(userText: string): boolean {
  void userText;
  return false;
}
