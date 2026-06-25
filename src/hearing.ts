/**
 * 听觉系统 — renderer 侧音频捕获 + STT WebSocket 客户端
 *
 * 职责：
 *   1. 麦克风捕获：navigator.mediaDevices.getUserMedia
 *   2. 系统音频捕获：Electron desktopCapturer (P2)
 *   3. AudioWorklet 重采样 → 16kHz PCM s16le mono
 *   4. WebSocket 连接 STT Server，发送 PCM 帧
 *   5. 接收转写结果，显示到聊天界面
 */

// ── 类型声明 ────────────────────────────────────────────────────────

declare global {
  interface Window {
    hearingAPI?: {
      start(source: string): Promise<{ ok: boolean; detail: string; wsUrl?: string }>;
      stop(): Promise<{ ok: boolean; detail: string }>;
      getStatus(): Promise<any>;
      onStarted(cb: (ev: { source: string; wsUrl: string; mode: string }) => void): () => void;
      onStopped(cb: () => void): () => void;
      onTranscription(cb: (result: TranscriptionEvent) => void): () => void;
      reportTranscription(result: TranscriptionEvent): void;
      reportCaptureFailed(reason: string): void;
      onTerminalBlock(cb: (ev: { blockId: string; line?: string; status?: 'running' | 'idle' | 'done' | 'error'; title?: string }) => void): () => void;
      onAutoSend(cb: (ev: { text: string; type: 'dictation' | 'summary' }) => void): () => void;
    };
  }
}

interface TranscriptionEvent {
  text: string;
  start: number;
  end: number;
  is_final: boolean;
  language: string;
  timestamp: number;
}

// ── 状态 ────────────────────────────────────────────────────────────

let audioContext: AudioContext | null = null;
let mediaStream: MediaStream | null = null;
let processorNode: ScriptProcessorNode | null = null;
let ws: WebSocket | null = null;
let isCapturing = false;

// ── 音频捕获 ────────────────────────────────────────────────────────

/**
 * 启动音频捕获并连接 STT WebSocket
 */
export async function startCapture(wsUrl: string, source: 'mic' | 'system' | 'both' = 'mic'): Promise<void> {
  if (isCapturing) return;

  // 1. 获取音频流
  if (source === 'mic' || source === 'both') {
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (err) {
      console.error('[Hearing] 麦克风权限获取失败:', err);
      throw new Error('无法获取麦克风权限');
    }
  }

  if (source === 'system' || source === 'both') {
    // 系统音频捕获通过 Electron desktopCapturer loopback
    try {
      const systemStream = await getSystemAudioStream();
      if (systemStream) {
        if (source === 'both' && mediaStream) {
          // 合并两个音频流
          const combined = new MediaStream();
          for (const track of mediaStream.getAudioTracks()) combined.addTrack(track);
          for (const track of systemStream.getAudioTracks()) combined.addTrack(track);
          mediaStream = combined;
        } else {
          mediaStream = systemStream;
        }
      } else if (source === 'system') {
        throw new Error('系统音频未获取到音频轨道');
      }
    } catch (err) {
      console.error('[Hearing] 系统音频捕获失败:', err);
      if (source === 'system') {
        throw new Error(`无法捕获系统音频: ${(err as Error).message}`);
      }
      // both 模式下，系统音频失败不阻断麦克风
    }
  }

  if (!mediaStream) {
    throw new Error('无可用音频流');
  }

  // 2. 创建 AudioContext 并处理音频
  audioContext = new AudioContext({ sampleRate: 16000 });
  const sourceNode = audioContext.createMediaStreamSource(mediaStream);

  // 使用 ScriptProcessorNode（兼容性好）
  // bufferSize=4096 at 16kHz ≈ 256ms 每帧
  processorNode = audioContext.createScriptProcessor(4096, 1, 1);

  let pcmFrameCount = 0;
  processorNode.onaudioprocess = (e) => {
    if (!isCapturing || !ws || ws.readyState !== WebSocket.OPEN) return;

    const inputData = e.inputBuffer.getChannelData(0);
    // float32 → int16
    const pcm16 = new Int16Array(inputData.length);
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    ws.send(pcm16.buffer);

    pcmFrameCount++;
    if (pcmFrameCount <= 3 || pcmFrameCount % 100 === 0) {
      // 计算 RMS 能量值，帮助判断是否有实际音频
      let sum = 0;
      for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
      const rms = Math.sqrt(sum / inputData.length);
      console.log(`[Hearing] PCM frame #${pcmFrameCount}, rms=${rms.toFixed(6)}, bytes=${pcm16.byteLength}`);
    }
  };

  sourceNode.connect(processorNode);
  // 用静音 GainNode 驱动处理节点，避免系统回环音频重放
  const silentGain = audioContext.createGain();
  silentGain.gain.value = 0;
  processorNode.connect(silentGain);
  silentGain.connect(audioContext.destination);

  // 3. 连接 WebSocket
  await connectSTT(wsUrl);

  isCapturing = true;
  console.log('[Hearing] 音频捕获已启动');
}

/**
 * 停止音频捕获
 */
export function stopCapture(): void {
  isCapturing = false;

  // 停止 WebSocket
  if (ws) {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ cmd: 'stop' }));
      }
      ws.close();
    } catch { /* ignore */ }
    ws = null;
  }

  // 停止音频处理
  if (processorNode) {
    processorNode.disconnect();
    processorNode = null;
  }

  // 停止音频流
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      track.stop();
    }
    mediaStream = null;
  }

  // 关闭 AudioContext
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  console.log('[Hearing] 音频捕获已停止');
}

// ── WebSocket 连接 ──────────────────────────────────────────────────

function connectSTT(wsUrl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      ws!.send(JSON.stringify({ cmd: 'start' }));
      console.log('[Hearing] STT WebSocket 已连接');
      resolve();
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);

        // 跳过控制响应
        if (data.cmd) return;

        // 转写结果
        if (data.text) {
          const result: TranscriptionEvent = {
            text: data.text,
            start: data.start ?? 0,
            end: data.end ?? 0,
            is_final: data.is_final ?? true,
            language: data.language ?? 'zh',
            timestamp: Date.now(),
          };

          // 显示到聊天界面
          onTranscriptionResult(result);

          // 上报到 main 进程
          window.hearingAPI?.reportTranscription(result);
        }
      } catch {
        // 非 JSON
      }
    };

    ws.onclose = () => {
      console.log('[Hearing] STT WebSocket 断开');
      ws = null;
    };

    ws.onerror = (err) => {
      console.error('[Hearing] STT WebSocket 错误:', err);
      reject(new Error('WebSocket 连接失败'));
    };

    // 超时
    setTimeout(() => {
      if (ws && ws.readyState !== WebSocket.OPEN) {
        ws.close();
        reject(new Error('WebSocket 连接超时'));
      }
    }, 5000);
  });
}

// ── 系统音频捕获 (P2) ──────────────────────────────────────────────

async function getSystemAudioStream(): Promise<MediaStream | null> {
  try {
    console.log('[Hearing] 请求系统音频 (getDisplayMedia + loopback)...');
    // Electron desktopCapturer — main 进程 setDisplayMediaRequestHandler 提供 loopback 音频
    const stream = await navigator.mediaDevices.getDisplayMedia({
      audio: true,
      video: { width: 1, height: 1 },  // 最小视频（仅为了获取音频）
    });

    console.log('[Hearing] getDisplayMedia 返回:',
      'audio tracks:', stream.getAudioTracks().length,
      'video tracks:', stream.getVideoTracks().length,
    );

    // 只保留音频轨道
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.warn('[Hearing] 系统音频：未获取到音频轨道');
      // 停止视频轨道
      for (const track of stream.getVideoTracks()) track.stop();
      return null;
    }

    // 停止视频轨道（只要音频）
    for (const track of stream.getVideoTracks()) track.stop();

    const audioStream = new MediaStream(audioTracks);
    console.log('[Hearing] 系统音频捕获成功, track:', audioTracks[0].label, 'settings:', JSON.stringify(audioTracks[0].getSettings()));
    return audioStream;
  } catch (err) {
    console.error('[Hearing] 系统音频捕获失败:', err);
    return null;
  }
}

// ── 转写结果处理 ────────────────────────────────────────────────────

/** 转写结果回调（由 chat.ts 注册） */
let transcriptionCallback: ((result: TranscriptionEvent) => void) | null = null;

export function onTranscription(cb: (result: TranscriptionEvent) => void): void {
  transcriptionCallback = cb;
}

function onTranscriptionResult(result: TranscriptionEvent): void {
  console.log(`[Hearing] 转写: "${result.text}" (${result.language})`);
  transcriptionCallback?.(result);
}

export function isActive(): boolean {
  return isCapturing;
}
