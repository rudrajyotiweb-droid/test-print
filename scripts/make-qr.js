// Usage: npm run make-qr -- <shopId>   → writes qr-<shopId>.png in the current folder
import fs from 'node:fs/promises';
import path from 'node:path';
import { getShop, shopUrl } from '../src/lib/shops.js';
import { qrPng } from '../src/lib/qr.js';

const shopId = process.argv[2];
if (!shopId) {
  console.error('Usage: npm run make-qr -- <shopId>');
  process.exit(1);
}
if (!getShop(shopId)) console.warn(`Warning: shop "${shopId}" does not exist in the database (QR generated anyway).`);

const out = path.resolve(process.env.INIT_CWD || process.cwd(), `qr-${shopId}.png`);
await fs.writeFile(out, await qrPng(shopId, 1024));
console.log(`QR for ${shopUrl(shopId)}\nSaved to ${out}`);
