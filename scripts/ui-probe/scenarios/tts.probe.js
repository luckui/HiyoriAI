// 语音合成：用当前方案开一段流式朗读（不播放），看音频块和每句起点是否按顺序送达、首音频是否及时
// 本地方案会等服务就绪（最多 2 分钟）；TTS 关闭时只记录关闭
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const api = window.ttsAPI;
  const out = { ttsEnabled: await api.isEnabled() };
  if (!out.ttsEnabled) return out;

  for (let i = 0; i < 60 && !(await api.health()).ok; i++) await sleep(2000);
  out.healthy = (await api.health()).ok;

  const sentences = ['主人今天辛苦了哦，记得早点休息。', '这条弹幕说得好。', '下次直播我们就玩这个游戏吧！'];
  const started = performance.now();
  let firstAudioMs = null;
  let audioSec = 0;
  const marks = [];
  let id = null;
  const early = [];
  const error = await new Promise((resolve) => {
    const handle = (e) => {
      if (e.type === 'audio') {
        if (firstAudioMs === null) firstAudioMs = performance.now() - started;
        audioSec += e.pcm.byteLength / 2 / e.sampleRate;
      } else if (e.type === 'sentence') {
        marks.push([e.sentence, e.atSec]);
      } else if (e.type === 'end') {
        resolve(e.error ?? null);
      }
    };
    api.onStreamEvent((e) => (id === null ? early.push(e) : e.id === id && handle(e)));
    api.startStream(sentences).then((streamId) => {
      id = streamId;
      if (streamId === null) resolve('unavailable');
      for (const e of early) if (e.id === id) handle(e);
    });
    setTimeout(() => resolve('timeout'), 120_000);
  });

  out.streamError = error;
  out.gotAudio = audioSec > 3;
  out.sentenceOrder = marks.map(([i]) => i).join(',');
  out.marksIncreasing = marks.every(([, at], i) => i === 0 || at > marks[i - 1][1]);
  out.marksInsideAudio = marks.every(([, at]) => at < audioSec);
  out.firstAudioUnder3s = firstAudioMs !== null && firstAudioMs < 3000;
  // 计时随机器和负载变化，只打在控制台上，不参与对比
  console.log(`[tts probe] firstAudio=${Math.round(firstAudioMs)}ms audio=${audioSec.toFixed(2)}s marks=${JSON.stringify(marks)}`);
  return out;
})()
