import { describe, expect, it } from 'vitest';
import { runtimeTools } from '../runtime';

const toolsByName = new Map(runtimeTools.map((tool) => [tool.schema.function.name, tool]));

function requireTool(name: string) {
  const tool = toolsByName.get(name);
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool;
}

function parseSessionId(result: string): string {
  const match = result.match(/session_id: ([^\s]+)/);
  if (!match) throw new Error(`Missing session_id in result: ${result}`);
  return match[1];
}

describe('runtime tools', () => {
  it('starts a runtime session', async () => {
    const result = await requireTool('runtime_start').execute(
      {
        provider_id: 'fake',
        title: 'Tool Session',
        message: 'hello',
      },
      { conversationId: 'conv-tools-start' }
    );

    expect(result).toContain('runtime session started');
    expect(parseSessionId(String(result))).toBeTruthy();
  });

  it('sends messages and reports status', async () => {
    const startResult = await requireTool('runtime_start').execute(
      {
        provider_id: 'fake',
        title: 'Tool Session',
        message: 'hello',
      },
      { conversationId: 'conv-tools-send' }
    );
    const sessionId = parseSessionId(String(startResult));

    const sendResult = await requireTool('runtime_send').execute({
      session_id: sessionId,
      message: 'continue',
    });
    const statusResult = await requireTool('runtime_status').execute({
      session_id: sessionId,
    });

    expect(sendResult).toContain('message sent');
    expect(statusResult).toContain('fake received: continue');
  });

  it('lists runtime sessions', async () => {
    const result = await requireTool('runtime_list').execute({});

    expect(result).toContain('runtime sessions');
    expect(result).toContain('fake');
  });

  it('lists available runtime providers', async () => {
    const result = await requireTool('runtime_providers').execute({});

    expect(result).toContain('runtime providers');
    expect(result).toContain('provider_id: fake');
    expect(result).toContain('provider_id: codex');
  });

  it('interrupts a runtime session', async () => {
    const startResult = await requireTool('runtime_start').execute(
      {
        provider_id: 'fake',
        title: 'Interrupt Session',
        message: 'hello',
      },
      { conversationId: 'conv-tools-interrupt' }
    );
    const sessionId = parseSessionId(String(startResult));

    const result = await requireTool('runtime_interrupt').execute({
      session_id: sessionId,
    });

    expect(result).toContain('interrupt requested');
  });
});
