export type TypewriterShow = (text: string, durationMs: number) => void;

export function shouldShowEstimatedTypewriter(
  chatExpanded: boolean,
  ttsEnabled: boolean,
): boolean {
  return !chatExpanded && !ttsEnabled;
}

export function createTypewriterPlaybackCallback(
  fullText: string,
  canShow: () => boolean,
  show: TypewriterShow,
): (actualMs: number, sentenceText?: string) => void {
  return (actualMs, sentenceText) => {
    if (!canShow()) return;

    const displayedText = sentenceText ?? fullText;
    const durationMs = actualMs > 0
      ? Math.max(300, actualMs * 0.92)
      : displayedText.length * 60;
    show(displayedText, durationMs);
  };
}
