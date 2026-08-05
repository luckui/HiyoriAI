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
        'Discover local Codex projects and resumable tasks from Codex app-server. ' +
        'Projects are cwd groups or Codex Desktop temporary workspaces; tasks are Codex threads. ' +
        'Prefer user-facing thread names over internal workspace folder names. ' +
        'Always distinguish task sources: Hiyori, Codex Desktop, app-server/automation, or external. ' +
        'Use this before coding_agent when the user names a project but does not provide a full cwd, ' +
        'or when the user asks what Codex projects/tasks exist on this computer. ' +
        'A limited list is not the total universe; use total_count/has_more in the result wording.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list_projects', 'list_tasks', 'resolve_project'],
            description:
              'list_projects lists Codex project/workspace groups; list_tasks lists Codex tasks/threads under a project/workspace; resolve_project maps a user project/task name to a cwd.',
          },
          project: {
            type: 'string',
            description: 'Project, workspace, or task name typed by the user, for example live2d, live2d-pet, or GF后处理.',
          },
          cwd: {
            type: 'string',
            description: 'Exact project/workspace directory when already known.',
          },
          query: {
            type: 'string',
            description: 'Natural project or task query to resolve, for example live2d.',
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
        return toolResult('没有找到', '回复用户', suggestedReply('我还没有在这台电脑上找到可恢复的 Codex 项目或任务。'));
      }
      const lines = projects.map((project, index) => [
        `${index + 1}. ${project.name}`,
        `路径：${project.cwd}`,
        `任务：${project.taskCount} 个`,
        `最近：${project.latestTaskTitle}，${formatTime(project.updatedAt)}`,
        `来源：${sourceText(project.sourceLabels)}`,
      ].join('\n'));
      const scope = index.hasMore
        ? `共找到 ${index.totalCount} 个 Codex 项目/工作区，当前显示最近 ${index.shownCount} 个。列表不代表全部；如果用户要找某个没显示的项目或任务，请继续用 resolve_project 精确查找。`
        : `共找到 ${index.totalCount} 个 Codex 项目/工作区。`;
      const more = index.hasMore
        ? `\n\n还有 ${index.totalCount - index.shownCount} 个更早的项目没有展开。要找特定项目的话，请告诉我项目名。`
        : '';
      return toolResult('已查询', '回复用户', [
        scope,
        suggestedReply(`我在这台电脑上找到了 ${index.totalCount} 个 Codex 项目/工作区。我按最近活动列成编号给你看：\n\n${lines.join('\n\n')}${more}`),
      ].join('\n'));
    }

    if (params.action === 'resolve_project') {
      const query = params.query ?? params.project ?? params.cwd ?? '';
      const resolved = await resolveCodexProject({ query, limit });
      if (resolved.status === 'matched') {
        const project = resolved.project;
        return toolResult('已匹配', '继续执行', [
          `项目/工作区: ${project.name}`,
          `cwd: ${project.cwd}`,
          `来源: ${sourceText(project.sourceLabels)}`,
          `最近任务: ${project.latestTaskId}`,
          `最近任务标题: ${project.latestTaskTitle}`,
          '如果用户要让 Codex 执行任务，请继续调用 coding_agent(action="send", cwd=上面的 cwd, task=用户任务)。',
        ].join('\n'));
      }
      if (resolved.status === 'ambiguous') {
        const choices = resolved.candidates.map((project, index) => (
          `${index + 1}. ${project.name}\n   cwd: ${project.cwd}\n   来源: ${sourceText(project.sourceLabels)}\n   最近任务: ${project.latestTaskTitle}`
        ));
        return toolResult('需要用户选择', '询问用户', suggestedReply(`我找到了多个可能的 Codex 项目/工作区，请选择一个：\n\n${choices.join('\n\n')}`));
      }
      return toolResult('没有找到', '询问用户', suggestedReply('我没有找到匹配的 Codex 项目或任务。请告诉我更完整的项目名，或先让我列出所有 Codex 项目/工作区。'));
    }

    if (params.action === 'list_tasks') {
      const tasks = await listCodexProjectTasks({
        project: params.project,
        cwd: params.cwd,
        limit,
      });
      if (!tasks.length) {
        return toolResult('没有找到', '回复用户', suggestedReply('我没有找到这个 Codex 项目/工作区下的可恢复任务。'));
      }
      const lines = tasks.map((task, index) => [
        `${index + 1}. ${task.title}`,
        `任务 ID：${task.id}`,
        `路径：${task.cwd}`,
        `来源：${task.sourceLabel}`,
        `最近：${formatTime(task.updatedAt)}`,
      ].join('\n'));
      return toolResult('已查询', '回复用户', suggestedReply(`这个 Codex 项目/工作区下有这些任务。我按最近活动列成编号给你看：\n\n${lines.join('\n\n')}`));
    }

    return toolResult('无法处理', '回复用户', suggestedReply('不支持的 Codex 项目查询操作。'));
  },
};

export default codexProjectsTool;
