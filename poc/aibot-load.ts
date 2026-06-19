// PoC: 在 Bun runtime 下加载 @wecom/aibot-node-sdk
// AiBot 是 default export; WSClient/MessageType/EventType 等是 named
import AiBotDefault, { WSClient, MessageType, EventType, TemplateCardType, generateReqId } from '@wecom/aibot-node-sdk';

console.log('[POC-1] import OK');
console.log('[POC-2] WSClient typeof:', typeof WSClient);
console.log('[POC-3] MessageType:', MessageType);
console.log('[POC-4] EventType:', EventType);
console.log('[POC-5] TemplateCardType:', TemplateCardType);
console.log('[POC-6] generateReqId("stream"):', generateReqId('stream'));
console.log('[POC-7] AiBot default namespace keys:', Object.keys(AiBotDefault || {}));

// 实例化
const wsClient = new WSClient({
  botId: 'poc-bot-id',
  secret: 'poc-secret',
});
console.log('[POC-8] WSClient instance OK, isConnected:', wsClient.isConnected);
console.log('[POC-9] prototype methods:', Object.getOwnPropertyNames(Object.getPrototypeOf(wsClient))
  .filter(m => !m.startsWith('_') && m !== 'constructor'));

// EventEmitter listener (不用真的 connect)
let events: string[] = [];
wsClient.on('connected', () => events.push('connected'));
wsClient.on('authenticated', () => events.push('authenticated'));
wsClient.on('disconnected', () => events.push('disconnected'));
wsClient.on('error', () => events.push('error'));
wsClient.on('message', () => events.push('message'));
wsClient.on('message.text', () => events.push('message.text'));
wsClient.on('event.template_card_event', () => events.push('event.template_card_event'));
console.log('[POC-10] all listeners attached:', events.length === 0 ? 'OK (no events yet)' : events);

// node:crypto / node:events / ws / Buffer 都应该 OK
const crypto = await import('node:crypto');
console.log('[POC-11] node:crypto.createHmac:', typeof crypto.createHmac);

const ws = await import('ws');
console.log('[POC-12] ws.WebSocket:', typeof ws.WebSocket);

console.log('\n=== POC RESULTS ===');
console.log('✅ Bun + SDK 兼容 (named imports, EventEmitter, ws, node:crypto)');