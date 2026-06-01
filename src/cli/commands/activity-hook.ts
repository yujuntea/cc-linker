import { writeActivityMarker } from '../../utils/session-activity';

interface HookOptions {
  platform?: 'feishu' | 'cli';
  action?: 'start' | 'end' | 'heartbeat';
  session?: string;
}

export async function activityHook(opts: HookOptions = {}): Promise<void> {
  const platform = opts.platform ?? 'cli';
  const action = opts.action ?? 'heartbeat';
  const sessionUuid = opts.session ?? process.env.CLAUDE_SESSION_ID;

  if (!sessionUuid) {
    console.error('error: --session <uuid> or CLAUDE_SESSION_ID env required');
    process.exit(1);
  }

  writeActivityMarker(sessionUuid, platform, action, process.pid);
  process.exit(0);
}
