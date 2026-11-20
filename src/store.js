import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { logger } from './logger.js';

/**
 * A tiny JSON-file store with atomic writes and debounced flushing.
 *
 * Deliberately not SQLite: the bot's persistent state is a few kilobytes
 * (tokens, a spend ledger, per-user notes), and staying dependency-free keeps
 * deploys to Railway/Render a single `npm ci` with no native build step.
 */
export class JsonStore {
    #file;
    #data;
    #flushTimer = null;
    #flushDelay;
    #writing = false;
    #dirty = false;

    constructor(file, fallback = {}, { flushDelay = 1000 } = {}) {
        this.#file = file;
        this.#data = fallback;
        this.#flushDelay = flushDelay;
    }

    async load() {
        try {
            this.#data = JSON.parse(await readFile(this.#file, 'utf8'));
        } catch (err) {
            if (err.code !== 'ENOENT') {
                logger.warn(`Store ${path.basename(this.#file)} unreadable (${err.message}) — starting fresh`);
            }
        }
        return this.#data;
    }

    get data() {
        return this.#data;
    }

    /** Mark dirty and schedule a flush. Cheap to call on every message. */
    touch() {
        this.#dirty = true;
        if (this.#flushTimer) return;
        this.#flushTimer = setTimeout(() => {
            this.#flushTimer = null;
            void this.flush();
        }, this.#flushDelay);
        this.#flushTimer.unref?.();
    }

    async flush() {
        if (this.#writing || !this.#dirty) return;
        this.#writing = true;
        this.#dirty = false;
        const tmp = `${this.#file}.tmp`;
        try {
            await mkdir(path.dirname(this.#file), { recursive: true });
            await writeFile(tmp, JSON.stringify(this.#data, null, 2), 'utf8');
            await rename(tmp, this.#file);
        } catch (err) {
            this.#dirty = true;
            logger.error(`Failed to persist ${path.basename(this.#file)}: ${err.message}`);
        } finally {
            this.#writing = false;
        }
    }

    /** Flush synchronously-ish on shutdown. */
    async close() {
        if (this.#flushTimer) {
            clearTimeout(this.#flushTimer);
            this.#flushTimer = null;
        }
        await this.flush();
    }
}
