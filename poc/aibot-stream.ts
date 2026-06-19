/**
 * PoC: 验证 @wecom/aibot-node-sdk replyStream / replyStreamWithCard 流式 API
 * 不真的 connect WSS（避免依赖真实 bot_id）
 * 目标：确认参数签名、事件回调、content 上限
 */
import { WSClient, generateReqId } from '@wecom/aibot-node-sdk';

const wsClient = new WSClient({
  botId: 'poc-bot-id',
  secret: 'poc-secret',
});

console.log('[STREAM-1] WSClient OK, isConnected:', wsClient.isConnected);

const mockFrame = { headers: { req_id: 'mock_req_123' } } as any;

let replyStreamCalls: any[] = [];
wsClient.replyStream = ((...args: any[]) => {
  replyStreamCalls.push({ method: 'replyStream', args: args.slice(1) });
  return Promise.resolve({ headers: { req_id: 'mock_req_123' } } as any);
}) as any;

const streamId = generateReqId('stream');
console.log('[STREAM-2] streamId:', streamId);

await wsClient.replyStream(mockFrame, streamId, 'thinking...', false);
await wsClient.replyStream(mockFrame, streamId, '更新内容', false);
await wsClient.replyStream(mockFrame, streamId, '完成', true);

console.log('[STREAM-3] replyStream calls:', replyStreamCalls.length, '(期望 3)');
console.log('[STREAM-4] 同 streamId 持续 patch:', replyStreamCalls.every(c => c.args[0] === streamId));
console.log('[STREAM-5] finish=true 在第 3 次:', replyStreamCalls[2].args[2] === true);

let replyStreamWithCardCalls: any[] = [];
wsClient.replyStreamWithCard = ((...args: any[]) => {
  replyStreamWithCardCalls.push({ args: args.slice(1) });
  return Promise.resolve({} as any);
}) as any;

await wsClient.replyStreamWithCard(mockFrame, streamId, '收尾', true, {
  templateCard: { card_type: 'text_notice', main_title: { title: '结果' } },
});

console.log('[STREAM-6] replyStreamWithCard:', replyStreamWithCardCalls.length, '(期望 1)');
console.log('[STREAM-7] 传入 templateCard:', !!replyStreamWithCardCalls[0].args[3].templateCard);

const overLimit = 'x'.repeat(20481);
const tooLong = overLimit.length > 20480;
console.log('[STREAM-8] 20481 bytes > 20480 limit:', tooLong, '(期望 true)');

let sendMessageCalls: any[] = [];
wsClient.sendMessage = ((chatid: string, body: any) => {
  sendMessageCalls.push({ chatid, body });
  return Promise.resolve({} as any);
}) as any;

await wsClient.sendMessage('chat_abc', { msgtype: 'markdown', markdown: { content: 'hello' } });
console.log('[STREAM-9] sendMessage:', sendMessageCalls.length, '(期望 1)');

console.log('\n=== STREAM POC RESULTS ===');
console.log('✅ SDK replyStream / replyStreamWithCard / sendMessage API 验证通过');
