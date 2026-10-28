import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, startOfTodayIso } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { bus, openSse } from '../lib/events.js';
import { getShop, adminShop, publicShop, hashToken, newAgentToken, issueActivationCode } from '../lib/shops.js';
import { getJob, adminJob, updateJob } from '../lib/jobs.js';
import { qrPng, qrPosterPdf } from '../lib/qr.js';
import { requireAdmin, setAdminCookie, clearAdminCookie } from '../middleware/auth.js';

export const adminRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

adminRouter.post('/login', loginLimiter, async (req, res) => {
  const { shopId, password } = req.body || {};
  const shop = getShop(String(shopId || '').trim());
  const ok = shop && (await bcrypt.compare(String(password || ''), shop.password_hash));
  if (!ok) return res.status(401).json({ error: 'Wrong shop ID or password', code: 'BAD_LOGIN' });
  if (shop.disabled) return res.status(403).json({ error: 'This shop account is disabled', code: 'SHOP_DISABLED' });
  setAdminCookie(res, shop.id);
  res.json(adminShop(shop));
});

adminRouter.post('/logout', (req, res) => {
  clearAdminCookie(res);
  res.json({ ok: true });
});

adminRouter.use(requireAdmin);

adminRouter.get('/me', (req, res) => res.json(adminShop(req.shop)));

function todayStats(shopId) {
  const since = startOfTodayIso();
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS jobs,
         COALESCE(SUM(CASE WHEN status = 'printed' THEN price END), 0) AS income,
         COALESCE(SUM(CASE WHEN status = 'printed' THEN print_pages * copies END), 0) AS pages,
         COALESCE(SUM(CASE WHEN status IN ('pending','printing') AND payment_status IN ('none','paid') THEN 1 END), 0) AS queued,
         COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 END), 0) AS failed
       FROM jobs WHERE shop_id = ? AND created_at >= ?`
    )
    .get(shopId, since);
  return { ...row, income: Math.round(row.income * 100) / 100 };
}

adminRouter.get('/jobs', (req, res) => {
  const status = String(req.query.status || '');
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const valid = ['pending', 'printing', 'printed', 'failed', 'cancelled'];
  const rows = valid.includes(status)
    ? db.prepare('SELECT * FROM jobs WHERE shop_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?').all(req.shop.id, status, limit)
    : db.prepare('SELECT * FROM jobs WHERE shop_id = ? ORDER BY created_at DESC LIMIT ?').all(req.shop.id, limit);
  res.json({ jobs: rows.map(adminJob), stats: todayStats(req.shop.id), shop: adminShop(getShop(req.shop.id)) });
});

function ownJob(req, res) {
  const job = getJob(req.params.id);
  if (!job || job.shop_id !== req.shop.id) {
    res.status(404).json({ error: 'Job not found' });
    return null;
  }
  return job;
}

adminRouter.post('/jobs/:id/reprint', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (!job.file_path || !storage.exists(job.file_path)) {
    return res.status(410).json({ error: 'The file was already deleted — ask the customer to upload again.' });
  }
  const updated = updateJob(job.id, {
    status: 'pending',
    error: null,
    printed_at: null,
    payment_status: job.payment_status === 'pending' ? 'none' : job.payment_status,
  });
  res.json(adminJob(updated));
});

adminRouter.post('/jobs/:id/cancel', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  if (!['pending', 'printing'].includes(job.status)) return res.status(409).json({ error: `Job is already ${job.status}` });
  res.json(adminJob(updateJob(job.id, { status: 'cancelled' })));
});

adminRouter.post('/jobs/:id/done', (req, res) => {
  const job = ownJob(req, res);
  if (!job) return;
  res.json(adminJob(updateJob(job.id, { status: 'printed', error: null, printed_at: new Date().toISOString() })));
});

adminRouter.get('/shop', (req, res) => res.json(adminShop(req.shop)));

adminRouter.put('/shop', async (req, res) => {
  const b = req.body || {};
  const s = req.shop;
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 && n <= 10000 ? Math.round(n * 100) / 100 : d;
  };
  const next = {
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : s.name,
    is_open: b.isOpen == null ? s.is_open : b.isOpen ? 1 : 0,
    bw_rate: num(b.bwRate, s.bw_rate),
    color_rate: num(b.colorRate, s.color_rate),
    supports_color: b.supportsColor == null ? s.supports_color : b.supportsColor ? 1 : 0,
    supports_duplex: b.supportsDuplex == null ? s.supports_duplex : b.supportsDuplex ? 1 : 0,
    password_hash: s.password_hash,
    id: s.id,
  };
  if (b.newPassword) {
    if (String(b.newPassword).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
    next.password_hash = await bcrypt.hash(String(b.newPassword), 10);
  }
  db.prepare(
    `UPDATE shops SET name=@name, is_open=@is_open, bw_rate=@bw_rate, color_rate=@color_rate,
       supports_color=@supports_color, supports_duplex=@supports_duplex, password_hash=@password_hash WHERE id=@id`
  ).run(next);
  const shop = getShop(s.id);
  bus.emit(`shop:${shop.id}`, { type: 'shop', shop: adminShop(shop) });
  res.json(adminShop(shop));
});

// One-time code the shop types into the desktop agent (it is exchanged for a token)
adminRouter.post('/activation-code', (req, res) => {
  res.json({ code: issueActivationCode(req.shop.id) });
});

// Agent tokens are stored hashed, so the only way to "see" one again is to issue a new one.
adminRouter.post('/agent-token', (req, res) => {
  const token = newAgentToken();
  db.prepare('UPDATE shops SET agent_token_hash = ? WHERE id = ?').run(hashToken(token), req.shop.id);
  res.json({ token, shopId: req.shop.id, serverUrl: config.apiUrl || `${req.protocol}://${req.get('host')}` });
});

adminRouter.get('/qr', async (req, res) => {
  const png = await qrPng(req.shop.id, 1024);
  res.set({
    'Content-Type': 'image/png',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="qr-${req.shop.id}.png"`,
  });
  res.send(png);
});

adminRouter.get('/qr-poster', async (req, res) => {
  const pdf = await qrPosterPdf(req.shop);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="qr-poster-${req.shop.id}.pdf"`,
  });
  res.send(pdf);
});

// Live updates for the admin panel
adminRouter.get('/events', (req, res) => {
  const sse = openSse(req, res);
  const key = `shop:${req.shop.id}`;
  const onEvent = (data) => sse.send(data);
  bus.on(key, onEvent);

  // Agent going offline is the absence of an event, so report it on a timer.
  const tick = setInterval(() => {
    const shop = getShop(req.shop.id);
    if (shop) sse.send({ type: 'agent', online: publicShop(shop).agentOnline, lastHeartbeatAt: shop.last_heartbeat_at });
  }, 15_000);

  sse.onClose(() => {
    bus.off(key, onEvent);
    clearInterval(tick);
  });
});
