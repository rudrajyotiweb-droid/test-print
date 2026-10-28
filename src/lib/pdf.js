import { PDFDocument } from 'pdf-lib';

/** Check PDF magic bytes ("%PDF-") within the first 1 KB — never trust the mime type alone. */
export function isPdf(buffer) {
  if (!buffer || buffer.length < 5) return false;
  return buffer.subarray(0, Math.min(1024, buffer.length)).includes(Buffer.from('%PDF-'));
}

export async function countPages(buffer) {
  const doc = await PDFDocument.load(buffer, { ignoreEncryption: true, updateMetadata: false });
  return doc.getPageCount();
}

/**
 * Parse a page range like "1-3,5" against a page total.
 * Returns a sorted array of unique 1-based page numbers, or null if the input is invalid.
 */
export function parseRange(input, total) {
  const str = String(input ?? '').replace(/\s+/g, '');
  if (!str) return null;
  const set = new Set();
  for (const part of str.split(',')) {
    if (!part) continue;
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > total) return null;
    for (let i = a; i <= b; i++) set.add(i);
  }
  return set.size ? [...set].sort((x, y) => x - y) : null;
}

/** Turn [1,2,3,5] into "1-3,5". */
export function formatRange(pages) {
  const out = [];
  for (let i = 0; i < pages.length; i++) {
    const start = pages[i];
    while (i + 1 < pages.length && pages[i + 1] === pages[i] + 1) i++;
    out.push(start === pages[i] ? `${start}` : `${start}-${pages[i]}`);
  }
  return out.join(',');
}
