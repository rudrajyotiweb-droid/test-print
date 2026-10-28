import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { getShop, hashToken } from '../lib/shops.js';

export const ADMIN_COOKIE = 'qrprint_admin';

function bearer(req) {
  const h = req.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** True if the request carries this shop's agent token. */
export function hasAgentToken(req, shop) {
  const token = bearer(req);
  return !!token && !!shop && safeEqual(hashToken(token), shop.agent_token_hash);
}

/** Shop id from a valid admin cookie, or null. */
export function adminShopId(req) {
  const token = req.cookies?.[ADMIN_COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret).sub;
  } catch {
    return null;
  }
}

/** Agent auth for routes that name the shop in ?shop= */
export function requireAgentForShopQuery(req, res, next) {
  const shop = getShop(String(req.query.shop || ''));
  if (!shop) return res.status(404).json({ error: 'Shop not found' });
  if (!hasAgentToken(req, shop)) return res.status(401).json({ error: 'Invalid agent token' });
  req.shop = shop;
  next();
}

export function requireAdmin(req, res, next) {
  const shopId = adminShopId(req);
  const shop = shopId && getShop(shopId);
  if (!shop) return res.status(401).json({ error: 'Not logged in' });
  if (shop.disabled) return res.status(403).json({ error: 'This shop account is disabled', code: 'SHOP_DISABLED' });
  req.shop = shop;
  next();
}

export const SUPER_COOKIE = 'qrprint_super';

export function requireSuper(req, res, next) {
  const token = req.cookies?.[SUPER_COOKIE];
  try {
    if (token && jwt.verify(token, config.jwtSecret).role === 'super') return next();
  } catch {
    /* invalid or expired */
  }
  res.status(401).json({ error: 'Not logged in' });
}

export function setSuperCookie(res) {
  const token = jwt.sign({ role: 'super' }, config.jwtSecret, { expiresIn: '7d' });
  const sameSite = config.cookieSameSite === 'none' ? 'none' : config.cookieSameSite === 'strict' ? 'strict' : 'lax';
  res.cookie(SUPER_COOKIE, token, {
    httpOnly: true,
    sameSite,
    secure: config.isProd || sameSite === 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function setAdminCookie(res, shopId) {
  const token = jwt.sign({ sub: shopId }, config.jwtSecret, { expiresIn: '7d' });
  const sameSite = config.cookieSameSite === 'none' ? 'none' : config.cookieSameSite === 'strict' ? 'strict' : 'lax';
  res.cookie(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite,
    secure: config.isProd || sameSite === 'none',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

export function clearAdminCookie(res) {
  res.clearCookie(ADMIN_COOKIE, { path: '/' });
}
