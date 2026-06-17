// src/agent-view/types.ts

// v2.6: 透明 fork 解析
// types-only import:运行时不构成循环依赖(fork-resolver 也会 import type ./types)
import type { ResolvedForkSummary } from './fork-resolver';

export type AgentSessionStatus = 'busy' | 'waiting' | 'idle' | 'unknown';

// v2.2.1: 来源标识 — 由 ~/.claude/daemon/roster.json 的 dispatch.source 推断
// - 'slash': 用户派发(TUI 可见,我们的 Agent View 展示)
// - 'spare': sub-agent(TUI 隐藏,我们也过滤掉)
// - 'fleet': daemon 内部任务(TUI 显示为 Completed,按 sub-agent 处理)
// - 'unknown': 找不到对应 roster 记录(daemon 未跑 / session 不在 roster 中)
export type AgentSessionSource = 'slash' | 'spare' | 'fleet' | 'unknown';

export interface AgentSession {
  pid: number;
  cwd: string;
  kind: 'background';
  startedAt: number;  // epoch ms
  sessionId: string;  // UUID
  name: string;
  status: AgentSessionStatus;
  source: AgentSessionSource;  // v2.2.1 新增
  waitingFor?: string;  // 仅 status === 'waiting' 时存在
  // v2.2.4 新增:true = 该 session 已 settled(从 daemon.log 兜底拿的),
  // active(--json)上报的 busy / waiting / idle 都是 false。
  // 视觉上由 buildListCard 单独渲染"已完成"section,与 active idle 区分。
  completed?: boolean;
  // v2.3 state.json 新增字段
  /** state.json.linkScanPath — JSONL 绝对路径;running/working 时为空 */
  linkScanPath?: string;
  /** state.json.detail — 活动摘要 / 等待问题 / 完成总结,列表卡副标题用 */
  detail?: string;
  /** state.json.intent — 原始派发命令,detail 空时回退用 */
  intent?: string;
  // v2.6: 透明 fork 解析
  /** 如果这个 session 自身已死(TUI 关了)但有活 fork 在跑,这里填 fork 的摘要
   *  UI 据此渲染 "🔄 已续接到 [new short]" 提示;handleList 据此过滤重复展示 */
  liveFork?: ResolvedForkSummary;
}

export type AgentSessionGroup = {
  busy: AgentSession[];
  waiting: AgentSession[];
  idle: AgentSession[];
  // v2.2.4 新增:已 settled(sessionId 是 short hash,无真实 UUID)
  completed: AgentSession[];
};

export function groupByStatus(sessions: AgentSession[]): AgentSessionGroup {
  return {
    busy: sessions.filter(s => s.status === 'busy'),
    waiting: sessions.filter(s => s.status === 'waiting'),
    idle: sessions.filter(s => s.status === 'idle' && !s.completed),
    // completed 仅匹配 (status === 'idle' && completed === true)——
    // snapshot-fetcher 只会把 settled (idle+completed) session 放进这个组,
    // 防止 active busy 错进 completed section
    completed: sessions.filter(s => s.status === 'idle' && s.completed === true),
  };
}
