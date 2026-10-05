/**
 * Skill: bili_research
 *
 * 让主人用一句话安排 B 站研究：「帮我转录老师好我叫何同学的全部视频」「记一下今天的热门」
 * 「搜一下量子力学科普，看看前 20 个为什么火」。真正的活由 biliResearch/research.ts 的任务执行器做
 * （后台一条条收集数据、弹幕、评论、字幕或转写、分析），这个工具只负责开任务、查进度、出报告。
 */

import type { ToolDefinition } from '../types';
import { researchRunner, summarizeJob } from '../../biliResearch/runtime';
import type { ResearchKind } from '../../biliResearch/research';

interface BiliResearchParams {
  action: 'start' | 'status' | 'stop' | 'report' | 'list';
  kind?: ResearchKind;
  target?: string;
  limit?: number;
  transcribe?: 'all' | 'auto';
  job_id?: string;
}

const STATUS_TEXT = { preparing: '准备中', running: '进行中', done: '已完成', stopped: '已停止', failed: '失败' } as const;

const biliResearchTool: ToolDefinition<BiliResearchParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'bili_research',
      description:
        'B 站视频研究：批量收集视频的数据、弹幕、热评和全文字幕（没有字幕就本地转写），逐条分析讲了什么、为什么火、有什么新梗，最后写成报告（Markdown + 流量数据 CSV）。\n' +
        '任务在后台跑，可能要很久（一个视频几秒到几分钟），开了就可以继续聊，过后用 status 看进度、report 拿报告。\n' +
        '直播时「B站情报站」环节会把正在做的任务展示给观众。\n\n' +
        'kind：\n' +
        '  - hot：今天的热门快照（热门 + 每周必看），默认 30 个，20 分钟以内没字幕的才转写\n' +
        '  - up：某个 UP 主的全部投稿，target 填 UP 主名字或 mid，默认 50 个\n' +
        '  - search：关键词搜索，按播放量取前 N 个，target 填关键词\n' +
        '  - videos：指定视频，target 填 BV 号或链接（多个用空格分开）\n' +
        'transcribe：all = 没字幕的都整段转写（up/search/videos 默认）；auto = 超过 20 分钟又没字幕的不转写（hot 默认）。\n' +
        '一次只能跑一个任务，start 会停掉正在跑的。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'status', 'stop', 'report', 'list'], description: '开任务 / 看进度 / 停 / 出报告 / 列出之前的任务' },
          kind: { type: 'string', enum: ['hot', 'up', 'search', 'videos'], description: 'start 时：任务种类' },
          target: { type: 'string', description: 'start 时：UP 主名字或 mid / 关键词 / BV 号' },
          limit: { type: 'number', description: 'start 时：最多多少个视频' },
          transcribe: { type: 'string', enum: ['all', 'auto'], description: 'start 时：转写策略' },
          job_id: { type: 'string', description: 'report 时：哪个任务（不填是当前的）' },
        },
        required: ['action'],
      },
    },
  },

  async execute(params) {
    const runner = researchRunner();
    if (!runner) return '❌ B 站研究模块没有启动';
    switch (params.action) {
      case 'start': {
        if (!params.kind) return '❌ 要说清楚研究什么：kind = hot / up / search / videos';
        const job = await runner.start({ kind: params.kind, target: params.target, limit: params.limit, transcribe: params.transcribe });
        if (job.status === 'failed') return `❌ 任务开不了：${job.error}`;
        return [
          `✅ 开始：${job.title}，共 ${job.items.length} 个视频（${job.spec.transcribe === 'all' ? '没字幕的整段转写' : '超过 20 分钟又没字幕的只记数据'}）`,
          '后台在跑，做完会自动写报告；可以用 status 看进度。',
          `前几个：${job.items.slice(0, 5).map((i) => `《${i.title.slice(0, 20)}》`).join('、')}`,
        ].join('\n');
      }
      case 'status': {
        const s = summarizeJob(runner.current);
        if (!s) return '现在没有研究任务。';
        return [
          `${s.title}：${STATUS_TEXT[s.status]}，完成 ${s.done}/${s.total}${s.skipped ? `，跳过 ${s.skipped}` : ''}`,
          s.working ? `正在处理：${s.working}` : '',
          s.reportFile ? `报告：${s.reportFile}` : '',
          s.error ? `错误：${s.error}` : '',
        ].filter(Boolean).join('\n');
      }
      case 'stop': {
        await runner.stop();
        return '已停止（做完的都存下来了，可以用 report 出一份中间报告）。';
      }
      case 'report': {
        const result = await runner.report(params.job_id);
        if (!result) return '❌ 没有这个任务';
        // 报告可能很长：给路径和开头，主人要细看就打开文件
        return `报告已写到：${result.file}\n\n${result.markdown.slice(0, 2500)}${result.markdown.length > 2500 ? '\n…（后面略，完整内容见文件）' : ''}`;
      }
      case 'list': {
        const jobs = runner.list();
        if (!jobs.length) return '还没有做过研究任务。';
        return jobs.map((j) => `- ${j.id}  ${j.title}（${STATUS_TEXT[j.status]}，${j.done}/${j.total}）${j.reportFile ? `  报告：${j.reportFile}` : ''}`).join('\n');
      }
      default:
        return `❌ 未知操作：${String(params.action)}`;
    }
  },
};

export default biliResearchTool;
