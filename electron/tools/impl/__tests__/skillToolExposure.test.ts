import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';
import { resolveToolset } from '../../../toolsets';

function readProjectFile(path: string): string {
  return readFileSync(resolve(process.cwd(), path), 'utf-8');
}

describe('skill tool exposure', () => {
  it('exposes read_skill instead of legacy manual tools', () => {
    const modes = ['agent', 'agent-debug', 'developer', 'worker', 'streamer'];

    for (const mode of modes) {
      const tools = resolveToolset(mode);
      expect(tools).toContain('read_skill');
      expect(tools).not.toContain('read_manual');
      expect(tools).not.toContain('manual_manage');
    }
  });

  it('does not package the legacy manual directory', () => {
    const pkg = readProjectFile('package.json');

    expect(pkg).not.toContain('"from": "electron/manual"');
  });

  it('does not force read_skill after run_command failures', () => {
    const source = readProjectFile('electron/tools/impl/runCommand.ts');

    expect(source).not.toContain('read_manual');
    expect(source).not.toContain('查说明书');
    expect(source).not.toContain('请立即调用');
  });
});
