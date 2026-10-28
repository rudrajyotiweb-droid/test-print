import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { bus } from './events.js';

export const getShop = (id) => db.prepare('SELECT * FROM shops WHERE id = ?').get(id);

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export const newAgentToken = () => `pat_${crypto.randomBytes(24).toString('base64url')}`;

export function newShopId() {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id = '';
  for (const b of crypto.randomBytes(8)) id += alphabet[b % alphabet.length];
  return id;
}

export function isAgentOnline(shop) {
  if (!shop?.last_heartbeat_at) return false;
  return Date.now() - Date.parse(shop.last_heartbeat_at) < config.agentOfflineAfterMs;
}

export function shopUrl(shopId) {
  return `${config.publicUrl}/s/${shopId}`;
}

/** Info safe to show to customers. */
export function publicShop(shop) {
  return {
    id: shop.id,
    name: shop.name,
    bwRate: shop.bw_rate,
    colorRate: shop.color_rate,
    supportsColor: !!shop.supports_color,
    supportsDuplex: !!shop.supports_duplex,
    isOpen: !!shop.is_open,
    agentOnline: isAgentOnline(shop),
    lastHeartbeatAt: shop.last_heartbeat_at,
    paymentEnabled: config.paymentEnabled,
    maxFileMb: config.maxFileMb,
  };
}

export async function createShop({ id, name, password, bwRate = 2, colorRate = 10, supportsColor = true, supportsDuplex = false }) {
  const agentToken = newAgentToken();
  const shop = {
    id: id || newShopId(),
    name,
    password_hash: await bcrypt.hash(password, 10),
    agent_token_hash: hashToken(agentToken),
    bw_rate: bwRate,
    color_rate: colorRate,
    supports_color: supportsColor ? 1 : 0,
    supports_duplex: supportsDuplex ? 1 : 0,
    is_open: 1,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO shops (id, name, password_hash, agent_token_hash, bw_rate, color_rate, supports_color, supports_duplex, is_open, created_at)
     VALUES (@id, @name, @password_hash, @agent_token_hash, @bw_rate, @color_rate, @supports_color, @supports_duplex, @is_open, @created_at)`
  ).run(shop);
  return { shop: getShop(shop.id), agentToken };
}

/** Record an agent heartbeat; notifies admin panels when the agent comes back online. */
export function touchHeartbeat(shop) {
  const wasOnline = isAgentOnline(shop);
  const at = nowIso();
  db.prepare('UPDATE shops SET last_heartbeat_at = ? WHERE id = ?').run(at, shop.id);
  if (!wasOnline) bus.emit(`shop:${shop.id}`, { type: 'agent', online: true, lastHeartbeatAt: at });
}
