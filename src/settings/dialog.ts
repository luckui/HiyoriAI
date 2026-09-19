/** 设置面板内的"是否保存修改"确认框 */

export function showUnsavedSettingsDialog(options: { body: string; saveText: string; discardText?: string }): Promise<'save' | 'discard'> {
  const dialog = document.getElementById('settings-unsaved-dialog');
  const body = dialog?.querySelector('p');
  const saveBtn = document.getElementById('settings-unsaved-save');
  const discardBtn = document.getElementById('settings-unsaved-discard');
  if (!dialog || !saveBtn || !discardBtn) {
    return Promise.resolve('discard');
  }
  if (body) body.textContent = options.body;
  saveBtn.textContent = options.saveText;
  discardBtn.textContent = options.discardText ?? '不保存';

  dialog.classList.add('visible');
  dialog.setAttribute('aria-hidden', 'false');

  return new Promise((resolve) => {
    const cleanup = (result: 'save' | 'discard') => {
      dialog.classList.remove('visible');
      dialog.setAttribute('aria-hidden', 'true');
      saveBtn.removeEventListener('click', onSave);
      discardBtn.removeEventListener('click', onDiscard);
      resolve(result);
    };
    const onSave = () => cleanup('save');
    const onDiscard = () => cleanup('discard');

    saveBtn.addEventListener('click', onSave);
    discardBtn.addEventListener('click', onDiscard);
  });
}
