import cron from 'node-cron';
import { db } from '../db.js';
import { config } from '../config.js';
import { storage } from '../storage.js';
import { getJob, emitJob, updateJob } from './jobs.js';

const ago = (ms) => new Date(Date.now() - ms).toISOString();

/** A job stuck in "printing" (agent crashed) goes back to the queue. */
export function recoverStuckJobs() {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE status = 'printing' AND updated_at < ?`)
    .all(ago(config.stuckPrintingMs));
  for (const { id } of rows) {
    updateJob(id, { status: 'pending', error: 'Re-queued: printer agent did not respond' });
    console.log(`[cron] re-queued stuck job ${id}`);
  }
}

/** Unpaid jobs are dropped after a while so they never reach the printer. */
export function cancelUnpaidJobs() {
  const rows = db
    .prepare(`SELECT id FROM jobs WHERE status = 'pending' AND payment_status = 'pending' AND created_at < ?`)
    .all(ago(config.unpaidJobTtlMs));
  for (const { id } of rows) updateJob(id, { status: 'cancelled', error: 'Payment not completed' });
}

/** Privacy: delete files after the retention window, and anything older than 24h regardless. */
export async function cleanupFiles() {
  const finished = db
    .prepare(
      `SELECT id, file_path FROM jobs
       WHERE file_path IS NOT NULL AND status IN ('printed','failed','cancelled') AND updated_at < ?`
    )
    .all(ago(config.fileRetentionMinutes * 60_000));

  const clear = db.prepare('UPDATE jobs SET file_path = NULL WHERE id = ?');
  for (const row of finished) {
    await storage.remove(row.file_path);
    clear.run(row.id);
    emitJob(getJob(row.id));
  }

  const cutoff = Date.now() - config.maxFileAgeMs;
  const byPath = db.prepare('SELECT id FROM jobs WHERE file_path = ?');
  let old = 0;
  for (const f of await storage.list()) {
    if (f.mtimeMs >= cutoff) continue;
    await storage.remove(f.key);
    const job = byPath.get(f.key);
    if (job) {
      clear.run(job.id);
      emitJob(getJob(job.id));
    }
    old++;
  }

  if (finished.length || old) console.log(`[cron] deleted ${finished.length} finished + ${old} expired file(s)`);
}

export function startCron() {
  const safe = (name, fn) => async () => {
    try {
      await fn();
    } catch (err) {
      console.error(`[cron] ${name} failed:`, err);
    }
  };
  cron.schedule('* * * * *', safe('recoverStuckJobs', recoverStuckJobs));
  cron.schedule('*/5 * * * *', safe('cleanupFiles', cleanupFiles));
  cron.schedule('*/5 * * * *', safe('cancelUnpaidJobs', cancelUnpaidJobs));
  // Run once at boot as well
  safe('boot', async () => {
    recoverStuckJobs();
    await cleanupFiles();
  })();
}
