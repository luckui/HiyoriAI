/**
 * Todo Tool - 任务管理工具
 * 
 * 为会话提供任务列表管理，帮助 AI 分解复杂任务、追踪执行进度。
 * 设计参考 Hermes-agent todo_tool。
 * 
 * 特性：
 * - 纯内存存储（会话级别，重启清空）
 * - 支持读取/写入两种模式
 * - 支持完全替换或增量合并
 * - 自动去重（按 id）
 */

import type { ToolDefinition } from '../types';

// ─── 类型定义 ────────────────────────────────────────

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoParams {
  todos?: TodoItem[];
  merge?: boolean;
}

// ─── 存储类 ──────────────────────────────────────────

class TodoStore {
  private items: TodoItem[] = [];

  /**
   * 写入任务列表
   * @param todos 任务数组
   * @param merge false=完全替换（默认），true=增量更新
   */
  write(todos: TodoItem[], merge: boolean): TodoItem[] {
    if (!merge) {
      // 完全替换模式：用新列表替换旧列表
      this.items = this.dedupe(this.validate(todos));
    } else {
      // 合并模式：按 id 更新现有项，添加新项
      const existing = new Map(this.items.map(t => [t.id, t]));
      
      for (const todo of this.validate(todos)) {
        if (existing.has(todo.id)) {
          // 更新现有项（仅更新提供的字段）
          const current = existing.get(todo.id)!;
          if (todo.content) current.content = todo.content;
          if (todo.status) current.status = todo.status;
        } else {
          // 新增项
          this.items.push(todo);
        }
      }
      
      // 去重（保持原有顺序）
      this.items = this.dedupe(this.items);
    }
    
    return this.read();
  }

  /**
   * 读取当前任务列表
   */
  read(): TodoItem[] {
    return JSON.parse(JSON.stringify(this.items)); // 深拷贝
  }

  /**
   * 获取活跃任务（pending + in_progress）
   * 用于上下文压缩后注入
   */
  getActiveTodos(): TodoItem[] {
    return this.items.filter(
      t => t.status === 'pending' || t.status === 'in_progress'
    );
  }

  /**
   * 检查是否有任务
   */
  hasItems(): boolean {
    return this.items.length > 0;
  }

  /**
   * 验证并规范化任务项
   */
  private validate(todos: TodoItem[]): TodoItem[] {
    return todos.map(t => ({
      id: String(t.id || '?').trim() || '?',
      content: String(t.content || '').trim() || '(无描述)',
      status: this.validateStatus(t.status)
    }));
  }

  /**
   * 验证状态值
   */
  private validateStatus(status: string): TodoStatus {
    const validStatuses: TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];
    const normalized = String(status || 'pending').toLowerCase().trim() as TodoStatus;
    return validStatuses.includes(normalized) ? normalized : 'pending';
  }

  /**
   * 按 id 去重（保留最后一次出现）
   */
  private dedupe(todos: TodoItem[]): TodoItem[] {
    const map = new Map<string, TodoItem>();
    todos.forEach(t => map.set(t.id, t));
    return Array.from(map.values());
  }
}

// ─── 全局存储管理 ────────────────────────────────────

const todoStores = new Map<string, TodoStore>();

/**
 * 获取指定会话的 TodoStore
 */
export function getTodoStore(conversationId: string): TodoStore {
  if (!todoStores.has(conversationId)) {
    todoStores.set(conversationId, new TodoStore());
  }
  return todoStores.get(conversationId)!;
}

// ─── 工具定义 ────────────────────────────────────────

const todoTool: ToolDefinition<TodoParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'todo',
      description: `【任务管理】管理当前会话的任务列表。用于 3 步以上的复杂任务或用户提供多个任务时。

调用方式：
- 无参数 → 读取当前任务列表
- 提供 todos[] → 写入/更新任务

写入模式：
- merge=false（默认）：用新列表完全替换旧列表（重新规划）
- merge=true：按 id 更新现有任务，添加新任务（增量调整）

任务格式：{id: 唯一标识, content: 任务描述, status: 状态}
状态值：pending | in_progress | completed | cancelled

约束：
- 列表顺序即优先级
- 同时只能有 1 个任务处于 in_progress
- 完成任务时立即标记为 completed
- 失败时标记为 cancelled，并创建修订后的新任务

始终返回完整任务列表。`,
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '任务数组。省略此参数则读取当前列表',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  description: '唯一标识符（如 "1", "refactor-module-a"）'
                },
                content: {
                  type: 'string',
                  description: '任务描述'
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed', 'cancelled'],
                  description: '任务状态'
                }
              },
              required: ['id', 'content', 'status']
            }
          },
          merge: {
            type: 'boolean',
            description: 'true=增量更新，false=完全替换（默认）',
            default: false
          }
        }
      } as any  // 使用 any 以支持复杂嵌套 schema（items.properties, default 等）
    }
  },

  async execute({ todos, merge = false }, context) {
    const conversationId = context?.conversationId;
    if (!conversationId) {
      return '❌ 错误：缺少 conversationId';
    }

    const store = getTodoStore(conversationId);
    
    let items: TodoItem[];
    
    if (todos !== undefined) {
      // 写入模式
      items = store.write(todos, merge);
    } else {
      // 读取模式
      items = store.read();
    }

    // 统计信息
    const summary = {
      total: items.length,
      pending: items.filter(t => t.status === 'pending').length,
      in_progress: items.filter(t => t.status === 'in_progress').length,
      completed: items.filter(t => t.status === 'completed').length,
      cancelled: items.filter(t => t.status === 'cancelled').length
    };

    // 格式化返回
    const lines: string[] = [
      `📋 当前任务列表（共 ${summary.total} 项）`,
      `   ⏳ 进行中：${summary.in_progress}`,
      `   ⏸️  待执行：${summary.pending}`,
      `   ✅ 已完成：${summary.completed}`
    ];

    if (summary.cancelled > 0) {
      lines.push(`   ❌ 已取消：${summary.cancelled}`);
    }

    lines.push('', '任务详情：');

    // 状态标记
    const statusMarkers: Record<TodoStatus, string> = {
      pending: '[ ]',
      in_progress: '[>]',
      completed: '[x]',
      cancelled: '[~]'
    };

    items.forEach(item => {
      const marker = statusMarkers[item.status] || '[?]';
      lines.push(`  ${marker} ${item.id}. ${item.content}`);
    });

    return lines.join('\n');
  }
};

export default todoTool;
