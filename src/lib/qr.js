import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { shopUrl } from './shops.js';

const BRAND = rgb(0.353, 0.184, 0.941);
const INK = rgb(0.086, 0.082, 0.114);
const MUTED = rgb(0.42, 0.42, 0.48);

export function qrPng(shopId, width = 1024) {
  return QRCode.toBuffer(shopUrl(shopId), {
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#16151dff', light: '#ffffffff' },
  });
}

// Standard PDF fonts only cover Latin-1; drop anything else (e.g. Bengali) rather than crash.
const latin = (s) => String(s || '').replace(/[^\x20-\x7E -ÿ]/g, '').replace(/\s+/g, ' ').trim();

function roundedRect(w, h, r) {
  return `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
}

/** Printable A4 poster with the shop's QR code. */
export async function qrPosterPdf(shop) {
  const doc = await PDFDocument.create();
  doc.setTitle(`Scan & Print — ${latin(shop.name) || shop.id}`);
  const page = doc.addPage([595.28, 841.89]);
  const { width: W, height: H } = page.getSize();
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const regular = await doc.embedFont(StandardFonts.Helvetica);

  const center = (text, y, font, size, color) => {
    const w = font.widthOfTextAtSize(text, size);
    page.drawText(text, { x: (W - w) / 2, y, size, font, color });
  };

  // Header band
  page.drawRectangle({ x: 0, y: H - 300, width: W, height: 300, color: BRAND });
  const name = latin(shop.name);
  if (name) center(name.toUpperCase().slice(0, 40), H - 70, bold, 16, rgb(0.86, 0.84, 1));
  center('SCAN & PRINT', H - 135, bold, 50, rgb(1, 1, 1));
  center('Print photos & PDFs straight from your phone', H - 170, regular, 15, rgb(0.9, 0.89, 1));

  // QR card
  const card = 330;
  const cardX = (W - card) / 2;
  const cardTop = H - 215;
  page.drawSvgPath(roundedRect(card, card, 28), {
    x: cardX,
    y: cardTop,
    color: rgb(1, 1, 1),
    borderColor: rgb(0.88, 0.87, 0.93),
    borderWidth: 1.5,
  });
  const qr = await doc.embedPng(await qrPng(shop.id, 900));
  const qrSize = card - 40;
  page.drawImage(qr, { x: cardX + 20, y: cardTop - card + 20, width: qrSize, height: qrSize });

  // Steps
  const steps = ['Scan the QR code', 'Upload photo or PDF', 'Collect at counter'];
  const colW = (W - 80) / 3;
  const stepY = cardTop - card - 90;
  steps.forEach((label, i) => {
    const cx = 40 + colW * i + colW / 2;
    page.drawCircle({ x: cx, y: stepY, size: 20, color: BRAND });
    const n = String(i + 1);
    page.drawText(n, { x: cx - bold.widthOfTextAtSize(n, 16) / 2, y: stepY - 6, size: 16, font: bold, color: rgb(1, 1, 1) });
    const lw = regular.widthOfTextAtSize(label, 13);
    page.drawText(label, { x: cx - lw / 2, y: stepY - 46, size: 13, font: regular, color: INK });
  });

  center('No app needed  ·  Works on any phone', 120, bold, 14, INK);
  center(latin(shopUrl(shop.id)), 60, regular, 10, MUTED);

  return Buffer.from(await doc.save());
}
