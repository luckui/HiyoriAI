/** 本地 Python 服务（TTS / STT）的状态与操作结果：主进程管理进程，渲染层的设置界面展示 */

export interface ServiceResult {
  ok: boolean;
  detail: string;
}

export interface PythonServiceStatus {
  installed: boolean;     // venv + 依赖已安装
  running: boolean;       // 进程存活
  healthy: boolean;       // /health 可达
  pid: number | null;
  port: number;
  serverDir: string;
}

export interface TtsServerStatus extends PythonServiceStatus {
  engine: string;
}

export type STTModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface SttServerStatus extends PythonServiceStatus {
  model: STTModelSize;
  language: string;
}
