import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { resolveToolset } from '../../../toolsets';
import { runtimeTools } from '../runtime';

const runtimeToolNames = [
  'runtime_start',
  'runtime_send',
  'runtime_status',
  'runtime_interrupt',
  'runtime_list',
  'runtime_providers',
];

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf-8');
}

describe('runtime tool registration', () => {
  it('exports the expected runtime tools', () => {
    expect(runtimeTools.map((tool) => tool.schema.function.name)).toEqual(runtimeToolNames);
  });

  it('exposes runtime tools to debug and developer modes only', () => {
    const chatTools = resolveToolset('chat');
    const agentDebugTools = resolveToolset('agent-debug');
    const developerTools = resolveToolset('developer');

    for (const name of runtimeToolNames) {
      expect(chatTools).not.toContain(name);
      expect(agentDebugTools).toContain(name);
      expect(developerTools).toContain(name);
    }
  });
});

describe('live streaming build boundaries', () => {
  it('does not define duplicate manage_bilibili_live switch cases', () => {
    const source = readProjectFile('electron/tools/impl/manageBilibiliLive.ts');
    const cases = [...source.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((match) => match[1]);

    expect(new Set(cases).size).toBe(cases.length);
  });

  it('keeps streamerController behind dynamic imports in non-streaming modules', () => {
    const liveTool = readProjectFile('electron/tools/impl/manageBilibiliLive.ts');

    expect(liveTool).not.toContain("from '../../streaming/streamerController'");
    expect(liveTool).toContain("import('../../streaming/streamerController')");
  });

  it('keeps manualGenerator behind dynamic imports in tool code', () => {
    const manualTool = readProjectFile('electron/tools/impl/manual_manage.ts');

    expect(manualTool).not.toContain("from '../../manual/manualGenerator'");
    expect(manualTool).toContain("import('../../manual/manualGenerator')");
  });

  it('loads Live2D core from public root instead of bundling it', () => {
    const html = readProjectFile('src/index.html');

    expect(html).toContain('<script src="/Core/live2dcubismcore.js"></script>');
    expect(html).not.toContain('<script src="./Core/live2dcubismcore.js"></script>');
  });
});
