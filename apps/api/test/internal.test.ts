import request from 'supertest';
import { reset, setup } from './helpers';

const SECRET = 'cron-secret-for-tests-0123456789';

describe('internal job triggers', () => {
  describe('without CRON_SECRET', () => {
    const { app, c } = setup();
    afterAll(() => c.close());

    it('the route does not exist', async () => {
      const res = await request(app).post('/internal/jobs/eod-close').expect(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });
  });

  describe('with CRON_SECRET', () => {
    const { app, c } = setup({ CRON_SECRET: SECRET });
    afterAll(async () => {
      await c.scheduledQueue().obliterate({ force: true });
      await c.close();
    });
    beforeEach(() => reset(c));

    it('rejects a missing or wrong secret', async () => {
      await request(app).post('/internal/jobs/eod-close').expect(401);
      await request(app).post('/internal/jobs/eod-close').set('Authorization', 'Bearer wrong').expect(401);
    });

    it('enqueues the job and returns 202 with its id', async () => {
      const res = await request(app)
        .post('/internal/jobs/eod-close')
        .set('Authorization', `Bearer ${SECRET}`)
        .send({ date: '2026-11-17' })
        .expect(202);
      expect(res.body).toMatchObject({ job: 'eod-close', jobId: expect.any(String) });
      const job = await c.scheduledQueue().getJob(res.body.jobId);
      expect(job?.name).toBe('eod-close');
      expect(job?.data).toEqual({ date: '2026-11-17' });
    });

    it('validates the job name and body', async () => {
      const auth = { Authorization: `Bearer ${SECRET}` };
      await request(app).post('/internal/jobs/drop-tables').set(auth).expect(400);
      await request(app).post('/internal/jobs/eod-close').set(auth).send({ date: 'yesterday' }).expect(400);
    });
  });
});
