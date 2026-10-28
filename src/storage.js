import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Storage interface: save / exists / stream / remove / list.
 * Swap LocalStorage for an S3/R2 implementation with the same methods later.
 */
export class LocalStorage {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  #file(key) {
    if (!/^[\w.-]+$/.test(key)) throw new Error('Invalid storage key');
    return path.join(this.dir, key);
  }

  async save(buffer, ext = '.pdf') {
    const key = `${crypto.randomUUID()}${ext}`;
    await fsp.writeFile(this.#file(key), buffer);
    return key;
  }

  exists(key) {
    try {
      return !!key && fs.existsSync(this.#file(key));
    } catch {
      return false;
    }
  }

  async size(key) {
    return (await fsp.stat(this.#file(key))).size;
  }

  stream(key) {
    return fs.createReadStream(this.#file(key));
  }

  async remove(key) {
    if (!key) return;
    await fsp.rm(this.#file(key), { force: true });
  }

  async list() {
    const names = await fsp.readdir(this.dir);
    const out = [];
    for (const key of names) {
      try {
        const st = await fsp.stat(path.join(this.dir, key));
        if (st.isFile()) out.push({ key, mtimeMs: st.mtimeMs });
      } catch {
        /* file vanished */
      }
    }
    return out;
  }
}

export const storage = new LocalStorage(config.uploadDir);
