import { runtimeHost, runtimeRegistry } from '../../runtimes';
import type { ToolContext, ToolDefinition } from '../types';

interface RuntimeStartParams {
  provider_id: string;
  title?: string;
  message: string;
  cwd?: string;
}

interface RuntimeSessionParams {
  session_id: string;
}

interface RuntimeSendParams extends RuntimeSessionParams {
  message: string;
  channel?: string;
}

function formatEventLine(event: { type: string; content: string; createdAt: number }): string {
  return `- ${new Date(event.createdAt).toISOString()} [${event.type}] ${event.content}`;
}

const runtimeStartTool: ToolDefinition<RuntimeStartParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_start',
      description:
        'Start a session with a registered agent runtime provider. Use this when the user wants Hiyori to delegate work to another local agent runtime.',
      parameters: {
        type: 'object',
        properties: {
          provider_id: {
            type: 'string',
            description: 'Registered runtime provider id.',
          },
          title: {
            type: 'string',
            description: 'Short title for the delegated runtime session.',
          },
          message: {
            type: 'string',
            description: 'Initial user message to send into the runtime session.',
          },
          cwd: {
            type: 'string',
            description: 'Optional working directory for providers that support it.',
          },
        },
        required: ['provider_id', 'message'],
      },
    },
  },
  async execute(params, context?: ToolContext) {
    const session = await runtimeHost.startSession({
      providerId: params.provider_id,
      hiyoriConversationId: context?.conversationId ?? 'default',
      title: params.title?.trim() || 'Runtime Session',
      initialMessage: params.message,
      cwd: params.cwd,
    });

    return [
      'runtime session started',
      `session_id: ${session.id}`,
      `provider_id: ${session.providerId}`,
      `status: ${session.status}`,
      `title: ${session.title}`,
    ].join('\n');
  },
};

const runtimeSendTool: ToolDefinition<RuntimeSendParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_send',
      description: 'Send a user message to an existing delegated runtime session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Runtime session id returned by runtime_start.',
          },
          message: {
            type: 'string',
            description: 'Message to forward into the runtime session.',
          },
          channel: {
            type: 'string',
            description: 'Optional source channel label for providers that preserve message metadata.',
          },
        },
        required: ['session_id', 'message'],
      },
    },
  },
  async execute(params) {
    await runtimeHost.sendMessage(params.session_id, {
      content: params.message,
      channel: params.channel,
    });
    return `message sent\nsession_id: ${params.session_id}`;
  },
};

const runtimeStatusTool: ToolDefinition<RuntimeSessionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_status',
      description: 'Read the current status and recent transcript events for a delegated runtime session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Runtime session id to inspect.',
          },
        },
        required: ['session_id'],
      },
    },
  },
  execute(params) {
    const session = runtimeHost.getSession(params.session_id);
    if (!session) return `runtime session not found\nsession_id: ${params.session_id}`;

    const events = runtimeHost.listEvents(params.session_id);
    const recentEvents = events.slice(-20);

    return [
      'runtime session status',
      `session_id: ${session.id}`,
      `provider_id: ${session.providerId}`,
      `status: ${session.status}`,
      `title: ${session.title}`,
      'recent_events:',
      recentEvents.length ? recentEvents.map(formatEventLine).join('\n') : '- none',
    ].join('\n');
  },
};

const runtimeInterruptTool: ToolDefinition<RuntimeSessionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_interrupt',
      description: 'Request interruption of a running delegated runtime session.',
      parameters: {
        type: 'object',
        properties: {
          session_id: {
            type: 'string',
            description: 'Runtime session id to interrupt.',
          },
        },
        required: ['session_id'],
      },
    },
  },
  async execute(params) {
    await runtimeHost.interrupt(params.session_id);
    return `interrupt requested\nsession_id: ${params.session_id}`;
  },
};

const runtimeListTool: ToolDefinition<Record<string, never>> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_list',
      description: 'List delegated runtime sessions known to Hiyori.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  execute() {
    const sessions = runtimeHost.listSessions();
    if (!sessions.length) return 'runtime sessions\n- none';

    return [
      'runtime sessions',
      ...sessions.map(
        (session) =>
          `- session_id: ${session.id} provider_id: ${session.providerId} status: ${session.status} title: ${session.title}`
      ),
    ].join('\n');
  },
};

const runtimeProvidersTool: ToolDefinition<Record<string, never>> = {
  schema: {
    type: 'function',
    function: {
      name: 'runtime_providers',
      description: 'List registered runtime providers and whether they are currently available.',
      parameters: {
        type: 'object',
        properties: {},
      },
    },
  },
  async execute() {
    const providers = runtimeRegistry.listProviders();
    const lines = await Promise.all(
      providers.map(async (provider) => {
        const availability = await runtimeRegistry.requireProvider(provider.id).checkAvailability();
        return [
          `- provider_id: ${provider.id}`,
          `  name: ${provider.displayName}`,
          `  available: ${availability.available}`,
          availability.reason ? `  reason: ${availability.reason}` : undefined,
        ]
          .filter(Boolean)
          .join('\n');
      })
    );

    return ['runtime providers', ...lines].join('\n');
  },
};

export const runtimeTools = [
  runtimeStartTool,
  runtimeSendTool,
  runtimeStatusTool,
  runtimeInterruptTool,
  runtimeListTool,
  runtimeProvidersTool,
];

export default runtimeTools;
