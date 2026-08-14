import { BrowserWindow } from 'electron';
import { getAgentMode, setAgentMode } from '../../agentMode';
import type { ToolDefinition } from '../types';

interface SwitchAgentModeParams {
  target_mode: 'chat' | 'agent' | 'agent-debug' | 'developer' | 'streamer' | 'minecraft';
  reason: string;
}

const modeNames: Record<SwitchAgentModeParams['target_mode'], string> = {
  chat: 'Chat mode',
  agent: 'Agent mode',
  'agent-debug': 'Agent-Debug mode',
  developer: 'Developer mode',
  streamer: 'Streamer mode (Bilibili live host)',
  minecraft: 'Minecraft mode',
};

const switchAgentMode: ToolDefinition<SwitchAgentModeParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'switch_agent_mode',
      description:
        'Switch the current agent mode. Use streamer for live streams and minecraft for Minecraft gameplay.',
      parameters: {
        type: 'object',
        properties: {
          target_mode: {
            type: 'string',
            enum: ['chat', 'agent', 'agent-debug', 'developer', 'streamer', 'minecraft'],
            description: 'Target mode: chat | agent | agent-debug | developer | streamer | minecraft.',
          },
          reason: {
            type: 'string',
            description: 'Short reason for switching modes.',
          },
        },
        required: ['target_mode', 'reason'],
      },
    },
  },

  async execute({ target_mode, reason }) {
    const currentMode = getAgentMode();
    if (currentMode === target_mode) {
      return `Already in ${modeNames[target_mode]}.`;
    }

    setAgentMode(target_mode);
    console.log(`[Agent Mode] ${currentMode} -> ${target_mode}`);
    console.log(`[Agent Mode] reason: ${reason}`);

    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      win.webContents.send('agent-mode:changed', target_mode);
    }

    return `Switched to ${modeNames[target_mode]}.\nReason: ${reason}`;
  },
};

export default switchAgentMode;
