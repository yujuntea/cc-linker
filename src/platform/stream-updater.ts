/**
 * 平台无关的流式更新接口
 * 接口形状贴近真实 CardUpdater（feishu/bot.ts:120-186）+ WecomStreamUpdater（PR 2 实现）
 * @see docs/superpowers/specs/2026-06-19-wecom-integration-design.md §4.1
 */

/** 流式更新中工具调用的摘要 */
export type StreamUpdateToolUse = {
  name: string;
  inputSummary: string;
};

export interface StreamUpdater {
  /** 启动一条流式消息（飞书：发送 processing 卡；企微：start stream）。返回消息 ID */
  startProcessing(userId: string): Promise<string>;

  /** 更新流式内容（飞书：patch card；企微：replyStream with same streamId）。
   *  thinking: 模型的思考过程文本
   *  text: 已生成的回复文本
   *  elapsedMs: 启动到现在的耗时（用于 UI 显示）
   *  toolUses: 工具调用摘要数组
   */
  updateStream(
    thinking: string,
    text: string,
    elapsedMs: number,
    toolUses?: StreamUpdateToolUse[],
  ): Promise<void>;

  /** 流式完成。飞书：patch complete card；企微：replyStream finish=true */
  complete(
    response: string,
    tokensIn: number,
    tokensOut: number,
    durationMs: number,
    numTurns: number,
  ): Promise<void>;

  /** 流式错误。飞书：patch error card；企微：replyStream finish=true with error text */
  error(message: string): Promise<void>;

  /** 流式取消（用户主动取消或新会话抢占） */
  cancel(reason?: string): Promise<void>;
}
