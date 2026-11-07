import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  schedule: vi.fn(async () => {}),
  secret: 'synthetic-cron-authority-secret',
}));
vi.mock('@/composition/render-output-cleanup-scheduler', () => ({
  scheduleRenderOutputCleanup: state.schedule,
}));
vi.mock('@/modules/kernel/backend', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAccountingConfig: () => ({ cronSecret: state.secret }),
}));
import { Route } from '@/routes/api/internal.rendering.cleanup';
const handler = (
  Route.options.server!.handlers as {
    GET: (context: { request: Request }) => Promise<Response>;
  }
).GET;
describe('render cleanup cron endpoint', () => {
  beforeEach(() => vi.clearAllMocks());
  it('owns its scheduled response after common cron authority validation', async () => {
    const response = await handler({
      request: new Request('http://localhost/api/internal/rendering/cleanup', {
        headers: { authorization: `Bearer ${state.secret}` },
      }),
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ type: 'render_cleanup_scheduled' });
    expect(state.schedule).toHaveBeenCalledOnce();
  });
  it('rejects missing authority without dispatching', async () => {
    expect(
      (
        await handler({
          request: new Request(
            'http://localhost/api/internal/rendering/cleanup'
          ),
        })
      ).status
    ).toBe(401);
    expect(state.schedule).not.toHaveBeenCalled();
  });
});
