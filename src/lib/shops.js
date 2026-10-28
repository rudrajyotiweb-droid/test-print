import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { bus } from './events.js';

export const getShop = (id) => db.prepare('SELECT * FROM shops WHERE id = ?').get(id);

export const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');
export const newAgentToken = () => `pat_${crypto.randomBytes(24).toString('base64url')}`;

const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomString(alphabet, length) {
  let out = '';
  for (const b of crypto.randomBytes(length)) out += alphabet[b % alphabet.length];
  return out;
}

export function newShopId() {
  return randomString(ID_ALPHABET, 8);
}

export const normalizeCode = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatCode = (code) => (code ? `${code.slice(0, 4)}-${code.slice(4)}` : null);

/** Issue a fresh one-time activation code for the desktop agent. */
export function issueActivationCode(shopId) {
  const taken = db.prepare('SELECT 1 FROM shops WHERE activation_code = ?');
  let code;
  do code = randomString(CODE_ALPHABET, 8);
  while (taken.get(code));
  db.prepare('UPDATE shops SET activation_code = ? WHERE id = ?').run(code, shopId);
  return formatCode(code);
}

export function isAgentOnline(shop) {
  if (!shop?.last_heartbeat_at) return false;
  return Date.now() - Date.parse(shop.last_heartbeat_at) < config.agentOfflineAfterMs;
}

/** Whether the shop may take jobs: not disabled and subscription not expired. */
export function serviceStatus(shop) {
  if (shop.disabled) return { active: false, reason: 'disabled' };
  if (shop.subscription_until && Date.parse(shop.subscription_until) < Date.now()) {
    return { active: false, reason: 'expired' };
  }
  return { active: true, reason: null };
}

export function shopUrl(shopId) {
  return `${config.publicUrl}/s/${shopId}`;
}

/** Info safe to show to customers. */
export function publicShop(shop) {
  const service = serviceStatus(shop);
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
    serviceActive: service.active,
    serviceReason: service.reason,
  };
}

/** Info for the shop owner and the super admin. */
export function adminShop(shop) {
  return {
    ...publicShop(shop),
    shopUrl: shopUrl(shop.id),
    disabled: !!shop.disabled,
    subscriptionUntil: shop.subscription_until,
    phone: shop.phone,
    createdAt: shop.created_at,
  };
}

export async function createShop({
  id,
  name,
  password,
  bwRate = 2,
  colorRate = 10,
  supportsColor = true,
  supportsDuplex = false,
  subscriptionUntil = null,
  phone = null,
  note = null,
}) {
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
    subscription_until: subscriptionUntil,
    phone,
    note,
    created_at: nowIso(),
  };
  db.prepare(
    `INSERT INTO shops (id, name, password_hash, agent_token_hash, bw_rate, color_rate, supports_color, supports_duplex,
       is_open, subscription_until, phone, note, created_at)
     VALUES (@id, @name, @password_hash, @agent_token_hash, @bw_rate, @color_rate, @supports_color, @supports_duplex,
       @is_open, @subscription_until, @phone, @note, @created_at)`
  ).run(shop);
  const activationCode = issueActivationCode(shop.id);
  return { shop: getShop(shop.id), agentToken, activationCode };
}

/** Record an agent heartbeat; notifies admin panels when the agent comes back online. */
export function touchHeartbeat(shop) {
  const wasOnline = isAgentOnline(shop);
  const at = nowIso();
  db.prepare('UPDATE shops SET last_heartbeat_at = ? WHERE id = ?').run(at, shop.id);
  if (!wasOnline) bus.emit(`shop:${shop.id}`, { type: 'agent', online: true, lastHeartbeatAt: at });
}
