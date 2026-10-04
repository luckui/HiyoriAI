/**
 * 主人按键说话（直播控制台）：按住按钮或空格（不在输入框里时）说话，松开交给她接话；
 * 在游戏里用全局热键 F8，按一下开始、再按一下说完。
 *
 * 麦克风一直开着但只在按住时把声音送给本地 faster-whisper（stt-server）：
 * 按下时发 start，松开时发 stop，服务端把剩下的音频转写完再回 stopped。
 * 只在按住时收音，她自己的声音不会被当成主人说的（按下那一刻她也已经停了）。
 */

const SAMPLE_RATE = 16000;
/** 松开后等转写结果最多这么久 */
const STOP_TIMEOUT_MS = 8000;

let ctx: AudioContext | null = null;
let stream: MediaStream | null = null;
let processor: ScriptProcessorNode | null = null;
let ws: WebSocket | null = null;
let held = false;
let texts: string[] = [];
let stopped: (() => void) | null = null;

export type PttState = 'off' | 'ready' | 'talking' | 'transcribing';
let state: PttState = 'off';
let onState: (s: PttState) => void = () => {};

function setState(next: PttState): void {
  state = next;
  onState(next);
}

export function pttState(): PttState {
  return state;
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => { socket.close(); reject(new Error('连接语音识别服务超时')); }, 5000);
    socket.onopen = () => { clearTimeout(timer); resolve(socket); };
    socket.onerror = () => { clearTimeout(timer); reject(new Error('连不上语音识别服务')); };
    socket.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as { text?: string; cmd?: string };
        if (data.text) texts.push(data.text);
        else if (data.cmd === 'stopped') stopped?.();
      } catch {
        // 不是 JSON
      }
    };
    socket.onclose = () => {
      if (ws === socket) {
        ws = null;
        if (state !== 'off') void disablePtt();
      }
    };
  });
}

export async function enablePtt(listener: (s: PttState) => void): Promise<string | null> {
  onState = listener;
  const result = await window.liveAPI.setOwnerMic(true);
  if (!result.ok || !result.wsUrl) return result.detail ?? '打不开主人麦克风';
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, sampleRate: SAMPLE_RATE, echoCancellation: true, noiseSuppression: true },
    });
    ws = await connect(result.wsUrl);
  } catch (err) {
    await disablePtt();
    return (err as Error).message || '拿不到麦克风';
  }
  ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(stream);
  // 2048 帧 ≈ 128ms 一块：松开时少等一点
  processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    if (!held || !ws || ws.readyState !== WebSocket.OPEN) return;
    const input = e.inputBuffer.getChannelData(0);
    const pcm = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    ws.send(pcm.buffer);
  };
  source.connect(processor);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  processor.connect(mute);
  mute.connect(ctx.destination);
  setState('ready');
  return null;
}

export async function disablePtt(): Promise<void> {
  held = false;
  processor?.disconnect();
  processor = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  void ctx?.close().catch(() => {});
  ctx = null;
  const socket = ws;
  ws = null;
  socket?.close();
  setState('off');
  await window.liveAPI.setOwnerMic(false);
}

/** 开始说：她立刻停下 */
export function pttDown(): void {
  if (state !== 'ready' || !ws) return;
  held = true;
  texts = [];
  ws.send(JSON.stringify({ cmd: 'start' }));
  setState('talking');
  void window.liveAPI.pttDown();
}

/** 说完：等转写，交给她 */
export async function pttUp(): Promise<string> {
  if (state !== 'talking' || !ws) return '';
  held = false;
  setState('transcribing');
  const done = new Promise<void>((resolve) => {
    stopped = resolve;
    setTimeout(resolve, STOP_TIMEOUT_MS);
  });
  ws.send(JSON.stringify({ cmd: 'stop' }));
  await done;
  stopped = null;
  const text = texts.join('').trim();
  await window.liveAPI.pttUp(text);
  if (pttState() === 'transcribing') setState('ready');
  return text;
}

export function pttToggle(): void {
  if (state === 'talking') void pttUp();
  else pttDown();
}
