/**
 * Skill: manage_tts
 *
 * 管理 TTS 语音合成功能（多引擎：edge-tts / moss-tts-nano / genie-tts）。
 * 支持操作：status / install / start / stop / install_and_start / enable / disable / switch
 *
 * 该工具让 AI Agent 能响应用户的语音系统安装/管理请求，
 * 自动完成 Python 虚拟环境创建、依赖安装、服务启停、引擎切换。
 */

import { BrowserWindow } from 'electron';
import type { ToolDefinition, ToolExecuteResult } from '../types';
import * as mgr from '../../ttsServerManager';
import { getTTSConfig, updateTTSConfig } from '../../main';

/* ── 终端气泡推送 helper（复用 hearing:terminal-block 频道） ────── */
function sendTerminalBlock(ev: {
  blockId: string;
  line?: string;
  status?: 'running' | 'done' | 'error';
  title?: string;
}) {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('hearing:terminal-block', ev);
  }
}

interface ManageTTSParams {
  /** 要执行的操作 */
  action: 'status' | 'install' | 'start' | 'stop' | 'install_and_start' | 'enable' | 'disable' | 'switch';
  /** 引擎名称，可选。switch 操作必填。其余操作不填时自动使用当前 provider 的引擎。 */
  engine?: 'edge-tts' | 'moss-tts-nano' | 'genie-tts';
  /** 切换到的 provider key，switch 操作用 */
  provider?: string;
}

const manageTTSTool: ToolDefinition<ManageTTSParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manage_tts',
      description:
        '管理 TTS 语音合成功能（多引擎：edge-tts / moss-tts-nano / genie-tts）。\n' +
        '当用户说"开启语音"、"关闭语音"、"安装语音"、"切换语音引擎"等时使用此工具。\n\n' +
        '操作说明：\n' +
        '  - enable：开启语音（会自动启动本地服务，如未安装会提示）\n' +
        '  - disable：关闭语音（同时停止本地服务）\n' +
        '  - install_and_start：首次安装并启动\n' +
        '  - switch：切换到指定引擎（需指定 provider 参数）\n' +
        '  - status：查看当前状态\n\n' +
        '可用引擎：\n' +
        '  - edge-tts（默认）：在线，快速，免费\n' +
        '  - moss-tts-nano：离线，本地推理，支持音色克隆\n' +
        '  - genie-tts：离线，GPT-SoVITS ONNX，CPU 高质量推理，菲比音色，支持中/英/日/韩\n\n' +
        '可用 provider key：\n' +
        '  - local_edge_tts（edge-tts 引擎）\n' +
        '  - local_moss_nano（moss-tts-nano 引擎）\n' +
        '  - local_genie_tts（genie-tts 引擎，菲比音色）\n\n' +
        '【简单规则】\n' +
        '  用户说 开启/启用/打开 语音 → enable\n' +
        '  用户说 关闭/禁用/停止 语音 → disable\n' +
        '  用户说 安装语音 → install_and_start（默认 edge-tts）\n' +
        '  用户说 安装 MOSS/Nano 语音 → install_and_start + engine=moss-tts-nano\n' +
        '  用户说 切换到 MOSS → switch + provider=local_moss_nano\n' +
        '  用户说 安装 Genie/菲比 语音 → install_and_start + engine=genie-tts\n' +
        '  用户说 切换到 Genie/菲比 → switch + provider=local_genie_tts\n' +
        '  用户问语音状态 → status',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'install', 'start', 'stop', 'install_and_start', 'enable', 'disable', 'switch'],
            description: '要执行的操作。常用：enable=开启, disable=关闭, install_and_start=首次安装, switch=切换引擎',
          },
          engine: {
            type: 'string',
            enum: ['edge-tts', 'moss-tts-nano', 'genie-tts'],
            description: '引擎名称。install/start/stop 时指定操作哪个引擎，不填则自动使用当前 provider 的引擎。',
          },
          provider: {
            type: 'string',
            description: 'switch 操作时指定切换到的 provider key，如 local_edge_tts 或 local_moss_nano。',
          },
        },
        required: ['action'],
      },
    },
  },


  async execute(params: ManageTTSParams): Promise<ToolExecuteResult> {
    // 自动推断引擎：优先用参数，否则从当前 provider 取
    const resolveEngine = (): string | undefined => {
      if (params.engine) return params.engine;
      const cfg = getTTSConfig();
      return cfg.providers[cfg.activeProvider]?.localEngine;
    };

    switch (params.action) {
      case 'status': {
        const cfg = getTTSConfig();
        const activeP = cfg.providers[cfg.activeProvider];
        const engine = resolveEngine();
        const s = await mgr.getStatus(engine);
        const providerList = Object.entries(cfg.providers)
          .map(([k, v]) => `  ${k === cfg.activeProvider ? '▶' : ' '} ${k}: ${v.name}`)
          .join('\n');
        const lines = [
          `=== TTS 状态 ===`,
          `启用:     ${cfg.enabled ? '✅ 是' : '❌ 否'}`,
          `当前服务: ${activeP?.name ?? '(无)'} [${cfg.activeProvider}]`,
          `引擎:     ${activeP?.localEngine ?? '(外部)'}`,
          `服务地址: ${activeP?.baseUrl ?? '(未配置)'}`,
          '',
          `=== 可用服务商 ===`,
          providerList,
          '',
          `=== 本地服务 (${engine ?? 'edge-tts'}) ===`,
          `已安装:   ${s.installed ? '✅ 是' : '❌ 否'}`,
          `运行中:   ${s.running ? '✅ 是 (PID ' + s.pid + ')' : '❌ 否'}`,
          `健康检查: ${s.healthy ? '✅ 正常' : '❌ 不可达'}`,
        ];
        return lines.join('\n');
      }

      case 'install': {
        const engine = resolveEngine();
        const blockId = `tts-install-${Date.now()}`;
        sendTerminalBlock({ blockId, title: `安装 TTS (${engine ?? 'edge-tts'})`, status: 'running' });
        const logs: string[] = [];
        const result = await mgr.install((msg) => {
          logs.push(msg);
          sendTerminalBlock({ blockId, line: msg, status: 'running' });
        }, engine);
        sendTerminalBlock({ blockId, status: result.ok ? 'done' : 'error' });
        return result.ok
          ? `✅ 安装成功 (${engine ?? 'edge-tts'})\n${logs.join('\n')}\n${result.detail}`
          : `❌ 安装失败 (${engine ?? 'edge-tts'})\n${logs.join('\n')}\n${result.detail}`;
      }

      case 'start': {
        const engine = resolveEngine();
        const result = await mgr.startServer(engine);
        return result.ok
          ? `✅ ${result.detail}`
          : `❌ ${result.detail}`;
      }

      case 'stop': {
        const engine = resolveEngine();
        const result = await mgr.stopServer(engine);
        updateTTSConfig({ enabled: false });
        return result.ok
          ? `✅ ${result.detail}\nTTS 语音已禁用。`
          : `❌ ${result.detail}`;
      }

      case 'enable': {
        const cfg = getTTSConfig();
        const activeP = cfg.providers[cfg.activeProvider];
        const engine = activeP?.localEngine;
        // 如果当前 provider 是本地的，确保服务在运行
        if (activeP?.isLocal) {
          const status = await mgr.getStatus(engine);
          if (!status.installed) {
            return `❌ 本地 TTS 服务 (${engine ?? 'edge-tts'}) 尚未安装，请先使用 install_and_start 安装。`;
          }
          if (!status.running) {
            const startResult = await mgr.startServer(engine);
            if (!startResult.ok) {
              return `❌ 启动本地服务失败: ${startResult.detail}`;
            }
          }
        }
        updateTTSConfig({ enabled: true });
        return `✅ TTS 语音已开启\n服务: ${activeP?.name ?? cfg.activeProvider}`;
      }

      case 'disable': {
        const cfg2 = getTTSConfig();
        const engine = cfg2.providers[cfg2.activeProvider]?.localEngine;
        updateTTSConfig({ enabled: false });
        const st = await mgr.getStatus(engine);
        if (st.running) {
          await mgr.stopServer(engine);
        }
        return '✅ TTS 语音已关闭，服务已停止。';
      }

      case 'install_and_start': {
        const engine = resolveEngine();
        const blockId = `tts-install-start-${Date.now()}`;
        sendTerminalBlock({ blockId, title: `安装并启动 TTS (${engine ?? 'edge-tts'})`, status: 'running' });
        const logs: string[] = [];
        const result = await mgr.installAndStart((msg) => {
          logs.push(msg);
          sendTerminalBlock({ blockId, line: msg, status: 'running' });
        }, engine);
        sendTerminalBlock({ blockId, status: result.ok ? 'done' : 'error' });
        if (result.ok) {
          updateTTSConfig({ enabled: true });
          return [
            `✅ TTS 语音系统安装并启动成功！(${engine ?? 'edge-tts'})`,
            '',
            `进度日志:`,
            ...logs.map(l => `  ${l}`),
            '',
            result.detail,
            '',
            `语音已自动开启，回复将自动播放语音。`,
          ].join('\n');
        } else {
          return `❌ TTS 安装失败 (${engine ?? 'edge-tts'})\n${logs.join('\n')}\n${result.detail}`;
        }
      }

      case 'switch': {
        const targetProvider = params.provider;
        if (!targetProvider) {
          return '❌ switch 操作需要指定 provider 参数（如 local_edge_tts 或 local_moss_nano）';
        }
        const cfg3 = getTTSConfig();
        if (!(targetProvider in cfg3.providers)) {
          const available = Object.keys(cfg3.providers).join(', ');
          return `❌ 未找到 provider: ${targetProvider}\n可用: ${available}`;
        }
        const targetP = cfg3.providers[targetProvider];
        // 如果目标是本地的，检查是否已安装
        if (targetP.isLocal) {
          const targetStatus = await mgr.getStatus(targetP.localEngine);
          if (!targetStatus.installed) {
            return `❌ ${targetP.name} 尚未安装，请先用 install_and_start + engine=${targetP.localEngine} 安装。`;
          }
          if (!targetStatus.running) {
            const startResult = await mgr.startServer(targetP.localEngine);
            if (!startResult.ok) {
              return `❌ 启动 ${targetP.name} 失败: ${startResult.detail}`;
            }
          }
        }
        updateTTSConfig({ activeProvider: targetProvider, enabled: true });
        return `✅ 已切换到 ${targetP.name}\n引擎: ${targetP.localEngine ?? '外部'}\n语音已自动开启。`;
      }

      default:
        return `❌ 未知操作: ${(params as any).action}`;
    }
  },
};

export default manageTTSTool;
