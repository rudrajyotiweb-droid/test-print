# QR Print Shop — Backend

Express + SQLite API for a self-service QR printing system. Customers upload PDFs/photos from their phone. A print agent on the shop PC polls this API and prints the jobs.

## Run
```bash
npm install
cp .env.example .env          # edit JWT_SECRET, PUBLIC_URL, API_URL
npm run seed -- --id demo --name "Demo Print Shop" --password demo1234
npm run dev                   # or: npm start
```
`seed` prints the shop ID, admin password and agent token. The token is shown only once.

| Script | What it does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm start` | Start for production |
| `npm run seed -- [--id x] [--name "…"] [--password …] [--duplex] [--no-color]` | Create a shop |
| `npm run make-qr -- <shopId>` | Write `qr-<shopId>.png` |

Requires Node 20+.

## Environment
See [.env.example](.env.example). The important ones:
- `PUBLIC_URL`: URL of the customer web app. QR codes point to `PUBLIC_URL/s/<shopId>`.
- `API_URL`: public URL of this API, used for the file links sent to the print agent. Leave it empty to derive it from the request.
- `JWT_SECRET`: a long random string. **Must be changed in production.**
- `PAYMENT_ENABLED`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`: Razorpay payments. Off by default.
- `DB_PATH`, `UPLOAD_DIR`: storage paths, relative to this folder. Point them at a persistent disk in production.

## API
| | Endpoints |
|---|---|
| Public | `GET /api/shops/:id`, `POST /api/jobs` (multipart `file` + `settings` JSON), `GET /api/jobs/:id`, `GET /api/jobs/:id/events` (SSE) |
| Agent (`Authorization: Bearer <token>`) | `GET /api/agent/ping?shop=`, `GET /api/jobs/next?shop=` (200 job / 204 empty), `GET /api/jobs/:id/file`, `POST /api/jobs/:id/status` |
| Admin (JWT cookie) | `POST /api/admin/login`, `POST /api/admin/logout`, `GET /api/admin/me`, `GET /api/admin/jobs`, `POST /api/admin/jobs/:id/{reprint,cancel,done}`, `GET/PUT /api/admin/shop`, `POST /api/admin/agent-token`, `GET /api/admin/qr`, `GET /api/admin/qr-poster`, `GET /api/admin/events` (SSE) |
| Payments | `POST /api/payments/order`, `POST /api/payments/verify` (only with `PAYMENT_ENABLED=true`) |

## Behaviour
- The server checks the PDF magic bytes and counts the pages with pdf-lib. It always calculates the price itself.
- Job creation is rate-limited to 10 per minute per IP.
- A job stuck in `printing` for more than 5 minutes goes back to the queue.
- Files are deleted `FILE_RETENTION_MINUTES` after a job finishes, and any file older than 24 h is deleted. Uploads are never served publicly.
- The agent counts as offline after 60 s without a heartbeat. Each poll of `/api/jobs/next` counts as a heartbeat.

## Deploy (Railway / Render / VPS)
1. Start command: `npm start`.
2. Attach a **persistent volume** and set `DB_PATH=/data/print.db` and `UPLOAD_DIR=/data/uploads`.
3. Set `NODE_ENV=production`, `JWT_SECRET`, `PUBLIC_URL` and `API_URL`.
4. If the frontend is on a different domain, set `COOKIE_SAMESITE=none`. HTTPS is required.
5. Run `npm run seed -- …` once, from the platform's shell, to create a shop.
