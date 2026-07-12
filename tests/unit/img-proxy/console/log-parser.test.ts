import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readRecentLogLines, getTail, resetLogTail,
} from '../../../../src/img-proxy/console/log-parser';

const SAMPLE = `[2026-07-05T07:32:06.722Z] INFO {"alias":"glm-5.2","method":"POST","path":"/glm-5.2/v1/messages","stripped":0,"upstream_status":200,"duration_ms":7038,"headers_to_first_chunk_ms":234,"chunks":12,"bytes":12345,"stream_status":"complete","upstream_error_msg":null}
[2026-07-05T07:33:00.000Z] INFO {"alias":"byte-agent","method":"POST","path":"/byte-agent/v1/messages","stripped":1,"upstream_status":200,"duration_ms":120,"chunks":2,"bytes":50,"stream_status":"complete","upstream_error_msg":null}
[2026-07-05T07:34:00.000Z] INFO {"alias":"glm-5.2","method":"POST","path":"/glm-5.2/v1/messages","stripped":0,"upstream_status":429,"duration_ms":50,"chunks":0,"bytes":0,"stream_status":"upstream_unreachable","upstream_error_msg":"429"}
[2026-07-05T07:35:00.000Z] WARN alias=whoever path=/whoever/v1/messages unresolved
`;

describe('log-parser', () => {
  let tmpDir: string, logPath: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'log-parser-'));
    logPath = join(tmpDir, 'img-proxy.log');
    writeFileSync(logPath, SAMPLE);
    resetLogTail();  // 测试隔离
  });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('readRecentLogLines 倒序读最近 100 条', async () => {
    const entries = await readRecentLogLines({ logPath, limit: 10 });
    expect(entries.length).toBe(4);
    // 最新在前:WARN 行 parsed=null(非 JSON),但 raw 包含 alias
    expect(entries[0]!.parsed).toBeNull();
    expect(entries[0]!.raw).toContain('whoever');
    expect(entries[1]!.parsed?.alias).toBe('glm-5.2');
    expect(entries[1]!.parsed?.stream_status).toBe('upstream_unreachable');
  });

  it('按 alias 过滤', async () => {
    const entries = await readRecentLogLines({ logPath, alias: 'glm-5.2' });
    expect(entries.length).toBe(2);
    expect(entries.every(e => e.parsed?.alias === 'glm-5.2')).toBe(true);
  });

  it('按 streamStatus 过滤', async () => {
    const entries = await readRecentLogLines({ logPath, streamStatus: 'complete' });
    expect(entries.length).toBe(2);
  });

  it('按 sinceMs 过滤', async () => {
    const sinceMs = new Date('2026-07-05T07:34:00.000Z').getTime();
    const entries = await readRecentLogLines({ logPath, sinceMs });
    expect(entries.length).toBe(2); // 07:34 + 07:35
  });

  it('LogTail 增量读(append 新行)', async () => {
    const tail = getTail(logPath);
    const first = await tail.readNew();
    expect(first.length).toBe(4);

    appendFileSync(logPath,
      `\n[2026-07-05T07:36:00.000Z] INFO {"alias":"new","method":"POST","path":"/new/v1/messages","stripped":0,"upstream_status":200,"duration_ms":10,"chunks":1,"bytes":5,"stream_status":"complete","upstream_error_msg":null}\n`,
    );
    const second = await tail.readNew();
    expect(second.length).toBe(1);
    expect(second[0]!.parsed?.alias).toBe('new');
  });

  it('LogTail singleton 跨调用共享 offset', async () => {
    const t1 = getTail(logPath);
    await t1.readNew();
    const t2 = getTail(logPath);
    expect(t2.offset).toBe(t1.offset);  // 同一个 instance
  });
});