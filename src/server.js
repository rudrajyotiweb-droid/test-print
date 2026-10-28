import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { config } from './config.js';
import './db.js';
import { agentRouter } from './routes/agent.js';
import { publicRouter } from './routes/public.js';
import { adminRouter } from './routes/admin.js';
import { paymentsRouter } from './routes/payments.js';
import { superRouter } from './routes/super.js';
import { startCron } from './lib/cron.js';

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors({ origin: config.publicUrl, credentials: true }));
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());

app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// Agent routes first so /api/jobs/next is not captured by /api/jobs/:id
app.use('/api', agentRouter);
app.use('/api', publicRouter);
app.use('/api/payments', paymentsRouter);
app.use('/api/admin', adminRouter);
app.use('/api/super', superRouter);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// In production the built React app is served from the same origin (keeps cookies + SSE simple).
// Note: uploads are never served statically.
if (fs.existsSync(path.join(config.clientDist, 'index.html'))) {
  app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(config.clientDist, 'index.html')));
} else {
  app.get('/', (req, res) => res.json({ name: 'QR Print Shop API', ok: true, health: '/api/health' }));
}

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    const error = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${config.maxFileMb} MB` : err.message;
    return res.status(status).json({ error, code: err.code });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
});

app.listen(config.port, () => {
  console.log(`[server] API on http://localhost:${config.port}  (customer app: ${config.publicUrl})`);
  console.log(`[server] payments ${config.paymentEnabled ? 'ENABLED' : 'disabled'}`);
  startCron();
});
