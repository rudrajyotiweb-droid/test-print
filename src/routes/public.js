import crypto from 'node:crypto';
import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { db, nowIso } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { bus, openSse } from '../lib/events.js';
import { getShop, publicShop, serviceStatus } from '../lib/shops.js';
import { getJob, publicJob, emitJob, generateCode, round2 } from '../lib/jobs.js';
import { isPdf, countPages, parseRange, formatRange } from '../lib/pdf.js';

export const publicRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileMb * 1024 * 1024, files: 1, fields: 10 },
});

const jobLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many print requests. Please wait a minute.', code: 'RATE_LIMIT' },
});

publicRouter.get('/shops/:shopId', (req, res) => {
  const shop = getShop(req.params.shopId);
  if (!shop) return res.status(404).json({ error: 'Shop not found', code: 'SHOP_NOT_FOUND' });
  res.json(publicShop(shop));
});

function readSettings(req) {
  let s = req.body?.settings ?? {};
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      s = null;
    }
  }
  return s && typeof s === 'object' ? s : null;
}

publicRouter.post('/jobs', jobLimiter, upload.single('file'), async (req, res) => {
  const s = readSettings(req);
  if (!s) return res.status(400).json({ error: 'Invalid settings JSON' });

  const shop = getShop(String(s.shopId || req.body.shopId || ''));
  if (!shop) return res.status(404).json({ error: 'Shop not found', code: 'SHOP_NOT_FOUND' });
  if (!serviceStatus(shop).active) {
    return res.status(403).json({ error: 'This shop is not accepting print jobs right now', code: 'SHOP_INACTIVE' });
  }

  const buf = req.file?.buffer;
  if (!buf) return res.status(400).json({ error: 'No file uploaded', code: 'NO_FILE' });
  if (!isPdf(buf)) return res.status(400).json({ error: 'Only PDF files are accepted', code: 'NOT_PDF' });

  let pageCount;
  try {
    pageCount = await countPages(buf);
  } catch {
    return res.status(400).json({ error: 'Could not read the PDF', code: 'BAD_PDF' });
  }
  if (!pageCount) return res.status(400).json({ error: 'PDF has no pages', code: 'BAD_PDF' });

  const copies = Number.parseInt(s.copies ?? 1, 10);
  if (!Number.isInteger(copies) || copies < 1 || copies > 50) {
    return res.status(400).json({ error: 'Copies must be between 1 and 50' });
  }
  const color = !!s.color;
  if (color && !shop.supports_color) return res.status(400).json({ error: 'This shop cannot print in color' });
  const paper = config.papers.includes(s.paper) ? s.paper : 'A4';
  const orientation = config.orientations.includes(s.orientation) ? s.orientation : 'auto';
  const duplex = !!s.duplex && !!shop.supports_duplex;

  let pages = null;
  let printPages = pageCount;
  if (s.pages != null && String(s.pages).trim() !== '') {
    const list = parseRange(s.pages, pageCount);
    if (!list) return res.status(400).json({ error: `Invalid page range (document has ${pageCount} pages)` });
    if (list.length < pageCount) {
      pages = formatRange(list);
      printPages = list.length;
    }
  }

  // Price is always computed on the server — never trust the client.
  const rate = color ? shop.color_rate : shop.bw_rate;
  const price = round2(printPages * copies * rate);
  const paymentStatus = config.paymentEnabled && price > 0 ? 'pending' : 'none';
  const customerName = String(s.customerName || '').trim().slice(0, 40) || null;

  const filePath = await storage.save(buf, '.pdf');
  const at = nowIso();
  const job = {
    id: crypto.randomUUID(),
    shop_id: shop.id,
    code: generateCode(shop.id),
    customer_name: customerName,
    file_path: filePath,
    page_count: pageCount,
    print_pages: printPages,
    copies,
    color: color ? 1 : 0,
    paper,
    orientation,
    duplex: duplex ? 1 : 0,
    pages,
    price,
    payment_status: paymentStatus,
    status: 'pending',
    created_at: at,
    updated_at: at,
  };
  db.prepare(
    `INSERT INTO jobs (id, shop_id, code, customer_name, file_path, page_count, print_pages, copies, color, paper,
       orientation, duplex, pages, price, payment_status, status, created_at, updated_at)
     VALUES (@id, @shop_id, @code, @customer_name, @file_path, @page_count, @print_pages, @copies, @color, @paper,
       @orientation, @duplex, @pages, @price, @payment_status, @status, @created_at, @updated_at)`
  ).run(job);

  const saved = getJob(job.id);
  emitJob(saved);
  res.status(201).json({
    id: saved.id,
    code: saved.code,
    price: saved.price,
    pageCount: saved.page_count,
    printPages: saved.print_pages,
    paymentRequired: paymentStatus === 'pending',
  });
});

publicRouter.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
  const shop = getShop(job.shop_id);
  res.json({ ...publicJob(job), shop: shop ? publicShop(shop) : null });
});

publicRouter.get('/jobs/:id/events', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const sse = openSse(req, res);
  sse.send(publicJob(job));

  const onJob = (data) => sse.send(data);
  bus.on(`job:${job.id}`, onJob);

  // Queue position changes when other jobs move — refresh it periodically while waiting.
  const refresh = setInterval(() => {
    const j = getJob(job.id);
    if (j && j.status === 'pending') sse.send(publicJob(j));
  }, 10_000);

  sse.onClose(() => {
    bus.off(`job:${job.id}`, onJob);
    clearInterval(refresh);
  });
});
