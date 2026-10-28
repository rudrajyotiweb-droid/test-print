import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { getShop } from '../lib/shops.js';
import { getJob, updateJob, publicJob } from '../lib/jobs.js';

// Razorpay, behind PAYMENT_ENABLED. Uses the REST API directly — no SDK needed.
export const paymentsRouter = Router();

paymentsRouter.use((req, res, next) => {
  if (!config.paymentEnabled) return res.status(404).json({ error: 'Payments are disabled' });
  next();
});

paymentsRouter.post('/order', async (req, res) => {
  const job = getJob(String(req.body?.jobId || ''));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.payment_status === 'paid') return res.status(409).json({ error: 'Already paid' });
  if (job.status === 'cancelled') return res.status(409).json({ error: 'Job was cancelled' });

  const amount = Math.round(job.price * 100);
  const auth = Buffer.from(`${config.razorpayKeyId}:${config.razorpayKeySecret}`).toString('base64');
  const r = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount,
      currency: 'INR',
      receipt: job.id.slice(0, 40),
      notes: { jobId: job.id, shopId: job.shop_id, code: job.code },
    }),
  });
  const order = await r.json().catch(() => ({}));
  if (!r.ok) return res.status(502).json({ error: order?.error?.description || 'Could not create payment order' });

  updateJob(job.id, { payment_order_id: order.id, payment_status: 'pending' });
  const shop = getShop(job.shop_id);
  res.json({ orderId: order.id, amount, currency: 'INR', keyId: config.razorpayKeyId, shopName: shop?.name, code: job.code });
});

paymentsRouter.post('/verify', (req, res) => {
  const { jobId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
  const job = getJob(String(jobId || ''));
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!razorpay_order_id || razorpay_order_id !== job.payment_order_id) {
    return res.status(400).json({ error: 'Order does not match this job' });
  }

  const expected = crypto
    .createHmac('sha256', config.razorpayKeySecret)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(razorpay_signature || ''));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(400).json({ error: 'Payment verification failed' });
  }

  const updated = updateJob(job.id, { payment_status: 'paid', payment_id: String(razorpay_payment_id) });
  res.json(publicJob(updated));
});
