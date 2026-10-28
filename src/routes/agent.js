import { Router } from 'express';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { getShop, touchHeartbeat } from '../lib/shops.js';
import { getJob, emitJob, updateJob } from '../lib/jobs.js';
import { hasAgentToken, adminShopId, requireAgentForShopQuery } from '../middleware/auth.js';

// Agent API — must stay in sync with agent/print_agent.py
export const agentRouter = Router();

function baseUrl(req) {
  return config.apiUrl || `${req.protocol}://${req.get('host')}`;
}

const claimNext = db.transaction((shopId) => {
  const job = db
    .prepare(
      `SELECT id FROM jobs
       WHERE shop_id = ? AND status = 'pending' AND file_path IS NOT NULL
         AND payment_status IN ('none','paid')
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(shopId);
  if (!job) return null;
  const res = db
    .prepare(`UPDATE jobs SET status = 'printing', error = NULL, updated_at = ? WHERE id = ? AND status = 'pending'`)
    .run(nowIso(), job.id);
  return res.changes ? getJob(job.id) : null;
});

// GET /api/agent/ping?shop=<shopId>  → verify agent credentials without claiming a job
agentRouter.get('/agent/ping', requireAgentForShopQuery, (req, res) => {
  touchHeartbeat(req.shop);
  res.json({ ok: true, id: req.shop.id, name: req.shop.name });
});

// GET /api/jobs/next?shop=<shopId>  → 200 job | 204 nothing to print
agentRouter.get('/jobs/next', requireAgentForShopQuery, (req, res) => {
  touchHeartbeat(req.shop);
  const job = claimNext(req.shop.id);
  if (!job) return res.status(204).end();
  emitJob(job);
  res.json({
    id: job.id,
    code: job.code,
    file_url: `${baseUrl(req)}/api/jobs/${job.id}/file`,
    copies: job.copies,
    color: !!job.color,
    paper: job.paper,
    pages: job.pages,
    duplex: !!job.duplex,
    orientation: job.orientation,
    customer_name: job.customer_name,
    page_count: job.page_count,
  });
});

// GET /api/jobs/:id/file  → PDF stream (agent token, or the shop's admin cookie)
agentRouter.get('/jobs/:id/file', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const shop = getShop(job.shop_id);
  const allowed = hasAgentToken(req, shop) || adminShopId(req) === job.shop_id;
  if (!allowed) return res.status(401).json({ error: 'Unauthorized' });
  if (!job.file_path || !storage.exists(job.file_path)) return res.status(410).json({ error: 'File was deleted' });

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="job-${job.code}.pdf"`,
    'Cache-Control': 'no-store',
  });
  const stream = storage.stream(job.file_path);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
});

// POST /api/jobs/:id/status  { status: "printed" | "failed", error? }
agentRouter.post('/jobs/:id/status', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  const shop = getShop(job.shop_id);
  if (!hasAgentToken(req, shop)) return res.status(401).json({ error: 'Invalid agent token' });
  touchHeartbeat(shop);

  const { status, error } = req.body || {};
  if (!['printed', 'failed'].includes(status)) {
    return res.status(400).json({ error: 'status must be "printed" or "failed"' });
  }
  if (job.status === 'cancelled') return res.status(409).json({ error: 'Job was cancelled' });

  const updated = updateJob(job.id, {
    status,
    error: status === 'failed' ? String(error || 'Print failed').slice(0, 500) : null,
    printed_at: status === 'printed' ? nowIso() : null,
  });
  res.json({ ok: true, status: updated.status });
});
