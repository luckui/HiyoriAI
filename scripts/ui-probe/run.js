#!/usr/bin/env node
/**
 * 界面行为探测：启动已构建的应用，通过 Chrome DevTools 协议在真实渲染进程里执行场景脚本，
 * 输出每一项观察结果（JSON）。改渲染层前后各跑一次并对比，就能确认行为有没有变。
 *
 * 用法（先 npm run build）：
 *   npm run ui-probe -- settings                      只看结果
 *   npm run ui-probe -- settings --out before.json    保存基准
 *   npm run ui-probe -- settings --compare before.json   与基准对比，有差异时退出码为 1
 *
 * 场景见 scenarios/*.probe.js（在页面里执行的异步表达式，返回观察结果对象）。
 */

const { spawn } = require('child_process');
const { existsSync, readFileSync, writeFileSync } = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const WebSocket = require(path.join(root, 'node_modules', 'ws'));
const electronBin = require(path.join(root, 'node_modules', 'electron'));

const PORT = Number(process.env.UI_PROBE_PORT ?? 9333);
const BOOT_WAIT_MS = 4000;

function parseArgs(argv) {
  const args = { scenario: undefined, out: undefined, compare: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') args.out = argv[++i];
    else if (argv[i] === '--compare') args.compare = argv[++i];
    else args.scenario = argv[i];
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findRendererPage() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) return page;
    } catch { /* 应用还没起来 */ }
    await sleep(500);
  }
  throw new Error('没有找到渲染进程页面：应用是否已构建（npm run build）？');
}

/** 连接页面的 CDP 会话：evaluate 执行表达式，errors 收集页面异常与 console.error */
async function connect(page) {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const errors = [];
  const pending = new Map();
  let nextId = 0;
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(`exception: ${d.exception?.description ?? d.text}`.slice(0, 300));
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      errors.push(`console.error: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`.slice(0, 300));
    }
  });
  const send = (method, params = {}) => new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable');
  return {
    errors,
    close: () => ws.close(),
    async evaluate(expression) {
      const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      const details = res.result?.exceptionDetails;
      if (details) throw new Error(`场景脚本出错：${details.exception?.description ?? details.text}`);
      return res.result?.result?.value;
    },
  };
}

function diff(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]))
    .map((k) => `  ${k}: ${JSON.stringify(before[k])} → ${JSON.stringify(after[k])}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const scenarioFile = path.join(__dirname, 'scenarios', `${args.scenario}.probe.js`);
  if (!args.scenario || !existsSync(scenarioFile)) {
    console.error('用法：npm run ui-probe -- <settings|chat> [--out 文件] [--compare 文件]');
    process.exit(2);
  }

  const app = spawn(electronBin, ['.', `--remote-debugging-port=${PORT}`], { cwd: root, stdio: 'ignore' });
  let result;
  try {
    const session = await connect(await findRendererPage());
    await sleep(BOOT_WAIT_MS); // 等渲染进程完成初始化（加载对话、Live2D 等）
    const observations = await session.evaluate(readFileSync(scenarioFile, 'utf8'));
    result = { scenario: args.scenario, observations, errors: session.errors };
    session.close();
  } finally {
    app.kill();
  }

  console.log(JSON.stringify(result, null, 2));
  if (args.out) writeFileSync(args.out, JSON.stringify(result, null, 2) + '\n');
  if (args.compare) {
    const baseline = JSON.parse(readFileSync(args.compare, 'utf8'));
    const changes = diff(baseline.observations, result.observations);
    if (result.errors.length) changes.push(`  页面报错：${result.errors.join(' | ')}`);
    if (changes.length) {
      console.error(`\n与基准不一致（${changes.length} 项）：\n${changes.join('\n')}`);
      process.exit(1);
    }
    console.error('\n与基准完全一致');
  }
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
