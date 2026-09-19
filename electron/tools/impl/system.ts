/**
 * 系统级原子操作工具集（Windows 桌面自动化）
 *
 * 工具列表：
 *   1. sys_key_press     - 按下键盘快捷键（如 win+r、ctrl+c、enter）
 *   2. sys_key_type      - 向当前焦点位置输入一段文字（逐字符发送）
 *   3. sys_mouse_move    - 移动鼠标到屏幕绝对坐标
 *   4. sys_mouse_click   - 点击屏幕绝对坐标（左/右/双击）
 *   5. sys_wait          - 等待指定毫秒（步骤间同步用）
 *
 * 实现依赖：@nut-tree/nut-js（纯 JS 桌面自动化，无需 C++ binding）
 * Windows 下可直接用，macOS/Linux 需授予辅助功能权限。
 *
 * 【注意】这些工具操作的是真实的操作系统输入事件，
 *         与 Playwright 浏览器沙箱完全独立，可操控任意窗口。
 */

import { keyboard, Key, mouse, Button, straightTo, Point } from '@nut-tree-fork/nut-js';
import type { ToolDefinition } from '../types';

// ── nut-js 全局配置 ───────────────────────────────────────────────

keyboard.config.autoDelayMs = 40;   // 按键间隔，太小容易丢失输入
mouse.config.autoDelayMs = 30;
mouse.config.mouseSpeed = 1500;     // 像素/秒，足够快但不会被系统限流

// ── 辅助：字符串 → nut-js Key 数组（支持组合键，用+分隔） ─────────

const KEY_MAP: Record<string, Key> = {
  win:        Key.LeftSuper,
  super:      Key.LeftSuper,
  meta:       Key.LeftSuper,
  ctrl:       Key.LeftControl,
  control:    Key.LeftControl,
  alt:        Key.LeftAlt,
  shift:      Key.LeftShift,
  enter:      Key.Return,
  return:     Key.Return,
  escape:     Key.Escape,
  esc:        Key.Escape,
  tab:        Key.Tab,
  space:      Key.Space,
  backspace:  Key.Backspace,
  delete:     Key.Delete,
  del:        Key.Delete,
  up:         Key.Up,
  down:       Key.Down,
  left:       Key.Left,
  right:      Key.Right,
  home:       Key.Home,
  end:        Key.End,
  pageup:     Key.PageUp,
  pagedown:   Key.PageDown,
  f1:         Key.F1,
  f2:         Key.F2,
  f3:         Key.F3,
  f4:         Key.F4,
  f5:         Key.F5,
  f6:         Key.F6,
  f7:         Key.F7,
  f8:         Key.F8,
  f9:         Key.F9,
  f10:        Key.F10,
  f11:        Key.F11,
  f12:        Key.F12,
  a: Key.A, b: Key.B, c: Key.C, d: Key.D, e: Key.E,
  f: Key.F, g: Key.G, h: Key.H, i: Key.I, j: Key.J,
  k: Key.K, l: Key.L, m: Key.M, n: Key.N, o: Key.O,
  p: Key.P, q: Key.Q, r: Key.R, s: Key.S, t: Key.T,
  u: Key.U, v: Key.V, w: Key.W, x: Key.X, y: Key.Y,
  z: Key.Z,
  '0': Key.Num0, '1': Key.Num1, '2': Key.Num2,
  '3': Key.Num3, '4': Key.Num4, '5': Key.Num5,
  '6': Key.Num6, '7': Key.Num7, '8': Key.Num8,
  '9': Key.Num9,
};

function parseKeys(combo: string): Key[] {
  return combo
    .split('+')
    .map(k => k.trim().toLowerCase())
    .map(k => {
      const resolved = KEY_MAP[k];
      if (!resolved) throw new Error(`未知按键名: "${k}"，支持: win/ctrl/alt/shift/enter/esc/tab/a-z/0-9/f1-f12/up/down 等`);
      return resolved;
    });
}

// ── 1. sys_key_press ─────────────────────────────────────────────

interface KeyPressParams { keys: string }

const sysKeyPress: ToolDefinition<KeyPressParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'sys_key_press',
      description:
        '向当前激活窗口发送键盘快捷键（组合键或单键）。\n' +
        '格式：用 + 连接多个键名，如 "win+r"、"ctrl+c"、"ctrl+shift+esc"、"enter"、"alt+f4"。\n' +
        '支持的键名：win/ctrl/alt/shift、enter/esc/tab/space/backspace/delete、' +
        'up/down/left/right/home/end/pageup/pagedown、f1-f12、a-z、0-9。\n' +
        '【典型用途】\n' +
        '  • 打开运行对话框：keys="win+r"\n' +
        '  • 确认/回车：keys="enter"\n' +
        '  • 全选：keys="ctrl+a"\n' +
        '  • 关闭窗口：keys="alt+f4"\n' +
        '  • 打开任务管理器：keys="ctrl+shift+esc"',
      parameters: {
        type: 'object',
        properties: {
          keys: {
            type: 'string',
            description: '快捷键组合，用 + 连接，如 "win+r"、"ctrl+c"、"enter"',
          },
        },
        required: ['keys'],
      },
    },
  },

  async execute({ keys }) {
    const parsed = parseKeys(keys);
    if (parsed.length === 1) {
      await keyboard.pressKey(parsed[0]);
      await keyboard.releaseKey(parsed[0]);
    } else {
      // 组合键：先全部按下，再逆序抬起
      for (const k of parsed) await keyboard.pressKey(k);
      for (const k of [...parsed].reverse()) await keyboard.releaseKey(k);
    }
    await new Promise(r => setTimeout(r, 120)); // 等系统处理输入
    return `✅ 已按下快捷键: ${keys}`;
  },
};

// ── 2. sys_key_type ───────────────────────────────────────────────

interface KeyTypeParams { text: string }

const sysKeyType: ToolDefinition<KeyTypeParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'sys_key_type',
      description:
        '向当前焦点位置输入一段文字（模拟键盘逐字符输入）。\n' +
        '适用于向系统对话框（运行、文件名输入、搜索框等）输入内容。\n' +
        '【注意】输入前必须确保目标输入框已获得焦点（可先用 sys_mouse_click 点击，或通过快捷键打开对话框后自动聚焦）。',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: '要输入的文字或命令，例如 "cmd"、"notepad"、"calc"',
          },
        },
        required: ['text'],
      },
    },
  },

  async execute({ text }) {
    await keyboard.type(text);
    await new Promise(r => setTimeout(r, 80));
    return `✅ 已输入文字: "${text}"`;
  },
};

// ── 3. sys_mouse_move ─────────────────────────────────────────────

interface MouseMoveParams { x: number; y: number }

const sysMouseMove: ToolDefinition<MouseMoveParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'sys_mouse_move',
      description:
        '将鼠标移动到屏幕绝对坐标位置（不点击）。\n' +
        '坐标以屏幕左上角为原点，X 向右，Y 向下，单位像素。\n' +
        '通常先调用 take_screenshot 截图确认位置后再使用。',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '屏幕 X 坐标（像素，从左边缘起）' },
          y: { type: 'number', description: '屏幕 Y 坐标（像素，从上边缘起）' },
        },
        required: ['x', 'y'],
      },
    },
  },

  async execute({ x, y }) {
    await mouse.move(straightTo(new Point(Math.round(x), Math.round(y))));
    return `✅ 鼠标已移至 (${Math.round(x)}, ${Math.round(y)})`;
  },
};

// ── 4. sys_mouse_click ────────────────────────────────────────────

interface MouseClickParams {
  x: number;
  y: number;
  button?: 'left' | 'right' | 'double';
}

const sysMouseClick: ToolDefinition<MouseClickParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'sys_mouse_click',
      description:
        '点击屏幕绝对坐标（操作系统级别，非浏览器内部）。\n' +
        '坐标以屏幕左上角为原点，X 向右，Y 向下，单位像素。\n' +
        '【何时用此工具而非 browser_click_smart】\n' +
        '  • 点击系统窗口（桌面、任务栏、文件资源管理器、系统对话框）\n' +
        '  • 点击非浏览器应用的界面元素\n' +
        '  • 需要先截图（take_screenshot）确认坐标后再点击',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'number', description: '屏幕 X 坐标（像素）' },
          y: { type: 'number', description: '屏幕 Y 坐标（像素）' },
          button: {
            type: 'string',
            enum: ['left', 'right', 'double'],
            description: '鼠标按键：left=左键单击（默认）、right=右键、double=左键双击',
          },
        },
        required: ['x', 'y'],
      },
    },
  },

  async execute({ x, y, button = 'left' }) {
    const px = Math.round(x);
    const py = Math.round(y);
    await mouse.move(straightTo(new Point(px, py)));
    await new Promise(r => setTimeout(r, 80));

    if (button === 'double') {
      await mouse.doubleClick(Button.LEFT);
    } else if (button === 'right') {
      await mouse.click(Button.RIGHT);
    } else {
      await mouse.click(Button.LEFT);
    }

    await new Promise(r => setTimeout(r, 120));
    return `✅ 已${button === 'double' ? '双击' : button === 'right' ? '右键' : '点击'} (${px}, ${py})`;
  },
};

// ── 5. sys_wait ───────────────────────────────────────────────────

interface SysWaitParams { ms: number }

const sysWait: ToolDefinition<SysWaitParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'sys_wait',
      description:
        '等待指定毫秒数，用于系统操作之间的同步（如等待窗口弹出、动画完成）。\n' +
        '常用值：200ms（快速响应）、500ms（对话框弹出）、1000ms（窗口启动）、2000ms（程序加载）。',
      parameters: {
        type: 'object',
        properties: {
          ms: {
            type: 'number',
            description: '等待毫秒数，建议范围 100 ~ 5000',
          },
        },
        required: ['ms'],
      },
    },
  },

  async execute({ ms }) {
    const safe = Math.max(50, Math.min(10000, Math.round(ms)));
    await new Promise(r => setTimeout(r, safe));
    return `✅ 已等待 ${safe}ms`;
  },
};

// ── 导出 ──────────────────────────────────────────────────────────

export const systemTools: ToolDefinition<never>[] = [
  sysKeyPress as ToolDefinition<never>,
  sysKeyType  as ToolDefinition<never>,
  sysMouseMove as ToolDefinition<never>,
  sysMouseClick as ToolDefinition<never>,
  sysWait     as ToolDefinition<never>,
];
