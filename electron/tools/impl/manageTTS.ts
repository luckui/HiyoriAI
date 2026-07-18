/**
 * manage_tts
 *
 * User-facing voice broadcast control. The tool exposes intent-level actions
 * only; install/start/stop are implementation details handled internally.
 */

import { BrowserWindow } from 'electron';
import type { ToolDefinition, ToolExecuteResult } from '../types';
import * as mgr from '../../ttsServerManager';
import { getTTSConfig, updateTTSConfig } from '../../main';

type TTSAction = 'status' | 'set_enabled' | 'set_provider';

interface ManageTTSParams {
  action: TTSAction;
  enabled?: boolean;
  provider?: string;
}

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

function toolReply(status: string, next: string, suggestedReply: string): string {
  return [
    '【工具结果】',
    `状态：${status}`,
    `下一步：${next}`,
    '建议回复：',
    suggestedReply,
  ].join('\n');
}

async function ensureLocalProviderReady(
  providerName: string,
  engine: string | undefined,
): Promise<{ ok: boolean; detail: string }> {
  const engineLabel = engine ?? 'edge-tts';
  const blockId = `tts-install-start-${Date.now()}`;
  sendTerminalBlock({
    blockId,
    title: `安装并启动 TTS (${engineLabel})`,
    status: 'running',
  });

  const logs: string[] = [];
  const result = await mgr.installAndStart((msg) => {
    logs.push(msg);
    sendTerminalBlock({ blockId, line: msg, status: 'running' });
  }, engine);

  sendTerminalBlock({ blockId, status: result.ok ? 'done' : 'error' });

  if (!result.ok) {
    return {
      ok: false,
      detail: [
        `TTS 服务 ${providerName} 启动失败。`,
        ...logs,
        result.detail,
      ].join('\n'),
    };
  }

  return { ok: true, detail: result.detail };
}

const manageTTSTool: ToolDefinition<ManageTTSParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manage_tts',
      description:
        '管理语音播报。只使用用户意图动作：开启/关闭语音播报、切换当前语音服务、查看状态。\n' +
        '用户说开启语音、打开语音、让你说话时，使用 set_enabled 并设置 enabled=true。\n' +
        '用户说关闭语音、不要朗读、禁用 TTS 时，使用 set_enabled 并设置 enabled=false。\n' +
        '用户要求换成某个声音或服务商时，使用 set_provider。只有语音播报已经开启时才能切换服务商；未开启时应提示用户先开启语音播报。\n' +
        '不要把安装、启动、停止作为用户要选择的概念；本工具会在需要时自动安装并启动当前服务商。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'set_enabled', 'set_provider'],
            description: 'status=查看状态；set_enabled=开启或关闭语音播报；set_provider=切换语音服务商。',
          },
          enabled: {
            type: 'boolean',
            description: 'set_enabled 时必填。true=开启语音播报，false=关闭语音播报。',
          },
          provider: {
            type: 'string',
            description: 'set_provider 时指定服务商 key，如 local_edge_tts、local_moss_nano、local_genie_tts。',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute(params: ManageTTSParams): Promise<ToolExecuteResult> {
    const cfg = getTTSConfig();

    switch (params.action) {
      case 'status': {
        const activeProvider = cfg.providers[cfg.activeProvider];
        const engine = activeProvider?.localEngine;
        const localStatus = activeProvider?.isLocal
          ? await mgr.getStatus(engine)
          : null;
        const providerLines = Object.entries(cfg.providers)
          .map(([key, provider]) => `${key === cfg.activeProvider ? '*' : '-'} ${provider.name} (${key})`)
          .join('\n');

        const statusText = [
          `语音播报：${cfg.enabled ? '已开启' : '未开启'}`,
          `当前服务：${activeProvider?.name ?? '(未配置)'} (${cfg.activeProvider})`,
          activeProvider?.isLocal && localStatus
            ? `本地服务：${localStatus.running ? '运行中' : '未运行'}，健康检查：${localStatus.healthy ? '正常' : '不可达'}`
            : '本地服务：外部服务商',
          '',
          '可用服务商：',
          providerLines,
        ].join('\n');

        return toolReply('已查询', '回复用户', statusText);
      }

      case 'set_enabled': {
        if (typeof params.enabled !== 'boolean') {
          return toolReply(
            '需要参数',
            '回复用户',
            '请说明是开启还是关闭语音播报。',
          );
        }

        const activeProvider = cfg.providers[cfg.activeProvider];
        if (!activeProvider) {
          return toolReply(
            '失败',
            '回复用户',
            `找不到当前语音服务商：${cfg.activeProvider}`,
          );
        }

        if (!params.enabled) {
          updateTTSConfig({ enabled: false });
          if (activeProvider.isLocal) {
            await mgr.stopServer(activeProvider.localEngine);
          }
          return toolReply('已关闭', '回复用户', '语音播报已关闭。');
        }

        if (activeProvider.isLocal) {
          const result = await ensureLocalProviderReady(activeProvider.name, activeProvider.localEngine);
          if (!result.ok) {
            updateTTSConfig({ enabled: false });
            return toolReply('启动失败', '回复用户', result.detail);
          }
        }

        updateTTSConfig({ enabled: true });
        return toolReply(
          '已开启',
          '回复用户',
          `语音播报已开启，当前服务商：${activeProvider.name}。`,
        );
      }

      case 'set_provider': {
        if (!cfg.enabled) {
          return toolReply(
            '无法切换',
            '回复用户',
            '语音播报未开启。请先开启语音播报，再切换语音服务商。',
          );
        }

        const targetKey = params.provider;
        if (!targetKey) {
          return toolReply(
            '需要参数',
            '回复用户',
            '请指定要切换的语音服务商。',
          );
        }

        const targetProvider = cfg.providers[targetKey];
        if (!targetProvider) {
          const available = Object.entries(cfg.providers)
            .map(([key, provider]) => `${provider.name} (${key})`)
            .join('\n');
          return toolReply(
            '未找到服务商',
            '回复用户',
            `没有找到语音服务商：${targetKey}\n可用服务商：\n${available}`,
          );
        }

        if (targetProvider.isLocal) {
          const result = await ensureLocalProviderReady(targetProvider.name, targetProvider.localEngine);
          if (!result.ok) {
            return toolReply('切换失败', '回复用户', result.detail);
          }
        }

        updateTTSConfig({ activeProvider: targetKey, enabled: true });
        return toolReply(
          '已切换',
          '回复用户',
          `已切换到 ${targetProvider.name}，语音播报保持开启。`,
        );
      }

      default:
        return toolReply('失败', '回复用户', `未知语音播报操作：${(params as { action: string }).action}`);
    }
  },
};

export default manageTTSTool;
