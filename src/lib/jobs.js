import crypto from 'node:crypto';
import { db, nowIso, startOfTodayIso } from '../db.js';
import { storage } from '../storage.js';
import { bus } from './events.js';

export const getJob = (id) => db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);

/** 4-digit pickup code, unique per shop per day. */
export function generateCode(shopId) {
  const exists = db.prepare('SELECT 1 FROM jobs WHERE shop_id = ? AND code = ? AND created_at >= ?');
  const since = startOfTodayIso();
  for (let i = 0; i < 100; i++) {
    const code = String(crypto.randomInt(1000, 10000));
    if (!exists.get(shopId, code, since)) return code;
  }
  throw new Error('Could not allocate a pickup code');
}

export function queuePosition(job) {
  if (job.status !== 'pending') return 0;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM jobs
       WHERE shop_id = ? AND status IN ('pending','printing') AND payment_status IN ('none','paid') AND created_at < ?`
    )
    .get(job.shop_id, job.created_at);
  return row.n + 1;
}

/** Shape shown to customers on the status page. */
export function publicJob(job) {
  return {
    id: job.id,
    shopId: job.shop_id,
    code: job.code,
    customerName: job.customer_name,
    status: job.status,
    error: job.error,
    pageCount: job.page_count,
    printPages: job.print_pages,
    copies: job.copies,
    color: !!job.color,
    paper: job.paper,
    orientation: job.orientation,
    duplex: !!job.duplex,
    pages: job.pages,
    price: job.price,
    paymentStatus: job.payment_status,
    queuePosition: queuePosition(job),
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    printedAt: job.printed_at,
  };
}

/** Shape shown to the shop admin. */
export function adminJob(job) {
  return { ...publicJob(job), fileAvailable: !!job.file_path && storage.exists(job.file_path) };
}

export function emitJob(job) {
  if (!job) return;
  bus.emit(`job:${job.id}`, publicJob(job));
  bus.emit(`shop:${job.shop_id}`, { type: 'job', job: adminJob(job) });
}

/** Update fields on a job, bump updated_at and broadcast the change. */
export function updateJob(id, fields) {
  const sets = Object.keys(fields).map((k) => `${k} = @${k}`);
  sets.push('updated_at = @updated_at');
  db.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = @id`).run({ ...fields, updated_at: nowIso(), id });
  const job = getJob(id);
  emitJob(job);
  return job;
}

export const round2 = (n) => Math.round(n * 100) / 100;
