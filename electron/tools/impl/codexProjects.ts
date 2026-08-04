import {
  listCodexProjectIndex,
  listCodexProjectTasks,
  resolveCodexProject,
} from '../../runtimes/providers/codexProjectDiscovery';
import type { ToolDefinition } from '../types';

type CodexProjectsAction = 'list_projects' | 'list_tasks' | 'resolve_project';

interface CodexProjectsParams {
  action: CodexProjectsAction;
  project?: string;
  cwd?: string;
  query?: string;
  limit?: number;
}

function toolResult(status: string, nextStep: '回复用户' | '询问用户' | '继续执行', body: string): string {
  return [
    '【工具结果】',
    `状态：${status}`,
    `下一步：${nextStep}`,
    body,
  ].join('\n');
}

function suggestedReply(text: string): string {
  return `建议回复：\n${text}`;
}

function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '未知';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

function sourceText(labels: string[]): string {
  return labels.length ? labels.join(' / ') : '未知来源';
}

const codexProjectsTool: ToolDefinition<CodexProjectsParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'codex_projects',
      description:
        'Discover local Codex projects and resumable tasks from Codex session history. ' +
        'Projects are cwd groups; tasks are Codex threads/sessions under a project. ' +
        'Always distinguish task sources: Hiyori, Codex Desktop, VSCode, SDK/automation, or external. ' +
        'Use this before coding_agent when the user names a project but does not provide a full cwd, ' +
        'or when the user asks what Codex projects/tasks exist on this computer. ' +
        'A limited list is not the total universe; use total_count/has_more in the result wording.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_projects', 'list_tasks', 'resolve_project'],
            description: 'list_projects lists project directories found in Codex history; list_tasks lists Codex tasks/threads under a project; resolve_project maps a user project name to a cwd using the full history.',
          },
          project: {
            type: 'string',
            description: 'Project name or alias typed by the user, for example live2d or live2d-pet.',
          },
          cwd: {
            type: 'string',
            description: 'Exact project directory when already known.',
          },
          query: {
            type: 'string',
            description: 'Natural project query to resolve, for example live2d.',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of projects or tasks to return.',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute(params) {
    const limit = Math.max(1, Math.min(params.limit ?? 8, 20));

    if (params.action === 'list_projects') {
      const index = await listCodexProjectIndex({ limit });
      const { projects } = index;
      if (!projects.length) {
        return toolResult('没有找到', '回复用户', suggestedReply('我还没有在这台电脑上找到可恢复的 Codex 项目。'));
      }
      const lines = projects.map((project, index) => [
        `${index + 1}. ${project.name}`,
        `   cwd：${project.cwd}`,
        `   任务数：${project.taskCount}`,
        `   来源：${sourceText(project.sourceLabels)}`,
        `   最近任务：${project.latestTaskTitle}`,
        `   最近活动：${formatTime(project.updatedAt)}`,
      ].join('\n'));
      const scope = index.hasMore
        ? `共找到 ${index.totalCount} 个 Codex 项目，当前显示最近 ${index.shownCount} 个。列表不代表全部；如果用户要找某个没显示的项目，请继续用 resolve_project 精确查找。`
        : `共找到 ${index.totalCount} 个 Codex 项目。`;
      return toolResult('已查询', '回复用户', [
        scope,
        suggestedReply(`我找到了这些 Codex 项目：\n\n${lines.join('\n\n')}`),
      ].join('\n'));
    }

    if (params.action === 'resolve_project') {
      const query = params.query ?? params.project ?? params.cwd ?? '';
      const resolved = await resolveCodexProject({ query, limit });
      if (resolved.status === 'matched') {
        const project = resolved.project;
        return toolResult('已匹配', '继续执行', [
          `项目：${project.name}`,
          `cwd：${project.cwd}`,
          `来源：${sourceText(project.sourceLabels)}`,
          `最近任务：${project.latestTaskId}`,
          `最近任务标题：${project.latestTaskTitle}`,
          '如果用户要让 Codex 执行任务，请继续调用 coding_agent(action="send", cwd=上面的 cwd, task=用户任务)。',
        ].join('\n'));
      }
      if (resolved.status === 'ambiguous') {
        const choices = resolved.candidates.map((project, index) => (
          `${index + 1}. ${project.name}\n   cwd：${project.cwd}\n   来源：${sourceText(project.sourceLabels)}\n   最近任务：${project.latestTaskTitle}`
        ));
        return toolResult('需要用户选择', '询问用户', suggestedReply(`我找到了多个可能的 Codex 项目，请选择一个：\n\n${choices.join('\n\n')}`));
      }
      return toolResult('没有找到', '询问用户', suggestedReply('我没有找到匹配的 Codex 项目。请告诉我更完整的项目名，或先让我列出所有 Codex 项目。'));
    }

    if (params.action === 'list_tasks') {
      const tasks = await listCodexProjectTasks({
        project: params.project,
        cwd: params.cwd,
        limit,
      });
      if (!tasks.length) {
        return toolResult('没有找到', '回复用户', suggestedReply('我没有找到这个 Codex 项目下的可恢复任务。'));
      }
      const lines = tasks.map((task, index) => [
        `${index + 1}. ${task.title}`,
        `   thread：${task.id}`,
        `   cwd：${task.cwd}`,
        `   来源：${task.sourceLabel}`,
        `   最近活动：${formatTime(task.updatedAt)}`,
      ].join('\n'));
      return toolResult('已查询', '回复用户', suggestedReply(`这个 Codex 项目下有这些任务：\n\n${lines.join('\n\n')}`));
    }

    return toolResult('无法处理', '回复用户', suggestedReply('不支持的 Codex 项目查询操作。'));
  },
};

export default codexProjectsTool;
