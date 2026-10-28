import crypto from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db, startOfTodayIso } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { bus } from '../lib/events.js';
import { adminShop, createShop, getShop, issueActivationCode, formatCode } from '../lib/shops.js';
import { requireSuper, setSuperCookie, SUPER_COOKIE } from '../middleware/auth.js';

// Platform owner panel: create shops, manage subscriptions, disable accounts.
export const superRouter = Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again later.' },
});

const SHOP_ID_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
const randomPassword = () => crypto.randomBytes(6).toString('base64url');

/** Extend from the later of now / current expiry. */
function addMonths(fromIso, months) {
  const base = fromIso && Date.parse(fromIso) > Date.now() ? new Date(fromIso) : new Date();
  base.setMonth(base.getMonth() + months);
  base.setHours(23, 59, 59, 0);
  return base.toISOString();
}

function shopRow(shop, stats) {
  return {
    ...adminShop(shop),
    note: shop.note,
    activationCode: formatCode(shop.activation_code),
    stats: stats || null,
  };
}

function notifyShop(shop) {
  bus.emit(`shop:${shop.id}`, { type: 'shop', shop: adminShop(shop) });
}

superRouter.post('/login', loginLimiter, (req, res) => {
  if (!config.superadminPassword) {
    return res.status(503).json({ error: 'Super admin is disabled. Set SUPERADMIN_PASSWORD on the server.', code: 'NO_SUPERADMIN' });
  }
  const given = Buffer.from(String(req.body?.password || ''));
  const expected = Buffer.from(config.superadminPassword);
  const ok = given.length === expected.length && crypto.timingSafeEqual(given, expected);
  if (!ok) return res.status(401).json({ error: 'Wrong password', code: 'BAD_LOGIN' });
  setSuperCookie(res);
  res.json({ ok: true });
});

superRouter.post('/logout', (req, res) => {
  res.clearCookie(SUPER_COOKIE, { path: '/' });
  res.json({ ok: true });
});

superRouter.use(requireSuper);

superRouter.get('/me', (req, res) => res.json({ ok: true, publicUrl: config.publicUrl }));

superRouter.get('/shops', (req, res) => {
  const since = startOfTodayIso();
  const shops = db.prepare('SELECT * FROM shops ORDER BY created_at DESC').all();
  const stats = db
    .prepare(
      `SELECT shop_id,
         COUNT(*) AS totalJobs,
         COALESCE(SUM(CASE WHEN created_at >= ? THEN 1 END), 0) AS todayJobs,
         COALESCE(SUM(CASE WHEN created_at >= ? AND status = 'printed' THEN price END), 0) AS todayIncome,
         COALESCE(SUM(CASE WHEN status = 'printed' THEN price END), 0) AS totalIncome,
         MAX(created_at) AS lastJobAt
       FROM jobs GROUP BY shop_id`
    )
    .all(since, since);
  const byShop = Object.fromEntries(stats.map((s) => [s.shop_id, s]));
  const empty = { totalJobs: 0, todayJobs: 0, todayIncome: 0, totalIncome: 0, lastJobAt: null };
  res.json({ shops: shops.map((s) => shopRow(s, byShop[s.id] || empty)), publicUrl: config.publicUrl });
});

superRouter.post('/shops', async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ error: 'Shop name is required' });

  const id = b.id ? String(b.id).trim().toLowerCase() : undefined;
  if (id && !SHOP_ID_RE.test(id)) {
    return res.status(400).json({ error: 'Shop ID: 3–32 characters, lowercase letters, numbers and dashes' });
  }
  if (id && getShop(id)) return res.status(409).json({ error: 'This shop ID is already taken' });

  const password = String(b.password || '').trim() || randomPassword();
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const months = Number(b.months);
  const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  const { shop, activationCode } = await createShop({
    id,
    name,
    password,
    bwRate: num(b.bwRate, 2),
    colorRate: num(b.colorRate, 10),
    supportsColor: b.supportsColor !== false,
    supportsDuplex: !!b.supportsDuplex,
    subscriptionUntil: months > 0 ? addMonths(null, months) : null,
    phone: b.phone ? String(b.phone).slice(0, 30) : null,
    note: b.note ? String(b.note).slice(0, 500) : null,
  });
  res.status(201).json({ shop: shopRow(shop), password, activationCode });
});

function findShop(req, res) {
  const shop = getShop(req.params.id);
  if (!shop) res.status(404).json({ error: 'Shop not found' });
  return shop;
}

superRouter.patch('/shops/:id', (req, res) => {
  const shop = findShop(req, res);
  if (!shop) return;
  const b = req.body || {};
  const next = {
    id: shop.id,
    name: typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 80) : shop.name,
    disabled: b.disabled == null ? shop.disabled : b.disabled ? 1 : 0,
    phone: b.phone === undefined ? shop.phone : b.phone ? String(b.phone).slice(0, 30) : null,
    note: b.note === undefined ? shop.note : b.note ? String(b.note).slice(0, 500) : null,
    subscription_until: shop.subscription_until,
  };
  if (b.subscriptionUntil !== undefined) {
    if (b.subscriptionUntil === null || b.subscriptionUntil === '') next.subscription_until = null;
    else {
      const d = new Date(b.subscriptionUntil);
      if (Number.isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid date' });
      d.setHours(23, 59, 59, 0);
      next.subscription_until = d.toISOString();
    }
  }
  db.prepare(
    `UPDATE shops SET name=@name, disabled=@disabled, phone=@phone, note=@note, subscription_until=@subscription_until
     WHERE id=@id`
  ).run(next);
  const updated = getShop(shop.id);
  notifyShop(updated);
  res.json(shopRow(updated));
});

superRouter.post('/shops/:id/extend', (req, res) => {
  const shop = findShop(req, res);
  if (!shop) return;
  const months = Number(req.body?.months);
  if (!Number.isInteger(months) || months < 1 || months > 60) return res.status(400).json({ error: 'months must be 1–60' });
  db.prepare('UPDATE shops SET subscription_until = ? WHERE id = ?').run(addMonths(shop.subscription_until, months), shop.id);
  const updated = getShop(shop.id);
  notifyShop(updated);
  res.json(shopRow(updated));
});

superRouter.post('/shops/:id/reset-password', async (req, res) => {
  const shop = findShop(req, res);
  if (!shop) return;
  const password = String(req.body?.password || '').trim() || randomPassword();
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  db.prepare('UPDATE shops SET password_hash = ? WHERE id = ?').run(await bcrypt.hash(password, 10), shop.id);
  res.json({ password });
});

superRouter.post('/shops/:id/activation-code', (req, res) => {
  const shop = findShop(req, res);
  if (!shop) return;
  res.json({ code: issueActivationCode(shop.id) });
});

superRouter.delete('/shops/:id', async (req, res) => {
  const shop = findShop(req, res);
  if (!shop) return;
  const files = db.prepare('SELECT file_path FROM jobs WHERE shop_id = ? AND file_path IS NOT NULL').all(shop.id);
  for (const f of files) await storage.remove(f.file_path);
  db.transaction(() => {
    db.prepare('DELETE FROM jobs WHERE shop_id = ?').run(shop.id);
    db.prepare('DELETE FROM shops WHERE id = ?').run(shop.id);
  })();
  res.json({ ok: true });
});
