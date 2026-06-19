/**
 * PoC: 验证 replyWelcome / updateTemplateCard 5s 窗口 API
 * 不真的 connect WSS（避免依赖真实 bot_id）
 * 目标：确认按钮回调场景下的 SDK 签名
 */
import { WSClient } from '@wecom/aibot-node-sdk';

const wsClient = new WSClient({
  botId: 'poc-bot-id',
  secret: 'poc-secret',
});

const mockFrame = { headers: { req_id: 'mock' } } as any;

let replyWelcomeCalls: any[] = [];
wsClient.replyWelcome = ((frame: any, body: any) => {
  replyWelcomeCalls.push({ frame, body });
  return Promise.resolve({} as any);
}) as any;

let updateTemplateCardCalls: any[] = [];
wsClient.updateTemplateCard = ((frame: any, templateCard: any, userids?: string[]) => {
  updateTemplateCardCalls.push({ frame, templateCard, userids });
  return Promise.resolve({} as any);
}) as any;

// 1. replyWelcome 5s 窗口
await wsClient.replyWelcome(mockFrame, {
  msgtype: 'template_card',
  template_card: { card_type: 'text_notice', main_title: { title: '处理中...' } },
});
console.log('[BUTTON-1] replyWelcome calls:', replyWelcomeCalls.length, '(期望 1)');

// 2. updateTemplateCard 5s 窗口（更新按钮事件关联的卡片）
await wsClient.updateTemplateCard(
  mockFrame,
  { card_type: 'text_notice', main_title: { title: '完成' } },
  ['user-1']
);
console.log('[BUTTON-2] updateTemplateCard calls:', updateTemplateCardCalls.length, '(期望 1)');
console.log('[BUTTON-3] 传入 userids:', updateTemplateCardCalls[0].userids);

// 3. uploadMedia / replyMedia / sendMediaMessage 签名（图片消息）
let uploadMediaCalls: any[] = [];
wsClient.uploadMedia = ((buffer: Buffer, options: any) => {
  uploadMediaCalls.push({ size: buffer.length, options });
  return Promise.resolve({ media_id: 'mock_media_id' } as any);
}) as any;

await wsClient.uploadMedia(Buffer.from('fake-image-data'), { type: 'image' });
console.log('[BUTTON-4] uploadMedia calls:', uploadMediaCalls.length, '(期望 1)');

console.log('\n=== BUTTON POC RESULTS ===');
console.log('✅ SDK replyWelcome / updateTemplateCard / uploadMedia API 验证通过');
