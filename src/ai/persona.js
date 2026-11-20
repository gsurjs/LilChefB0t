import { readFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { logger } from '../logger.js';

const FALLBACK_PERSONA = `# LilChef
You are LilChef, the chat bot for the Twitch channel ${config.twitch.channelName}.
Keep replies to two sentences at most. Be warm, concise, and useful.
Never claim to know live stream details without using a tool.`;

/**
 * Loads persona.md and keeps it hot.
 *
 * The persona is the stable head of every prompt, which makes it the right thing
 * to cache: it is identical across requests, and the cache breakpoint sits right
 * after it so everything volatile (recent chat, the question) falls outside.
 *
 * It is also the one file the streamer should be able to edit without a redeploy,
 * hence the watch. A reload changes the cached prefix, so the next request pays
 * a cache write once and then reads cheaply again.
 */
export class Persona {
    #text = FALLBACK_PERSONA;
    #watcher = null;
    #version = 0;

    async load() {
        try {
            const raw = await readFile(config.personaFile, 'utf8');
            const trimmed = raw.trim();
            if (trimmed) {
                this.#text = trimmed;
                this.#version += 1;
            } else {
                logger.warn('persona.md is empty — using the built-in fallback persona');
            }
        } catch (err) {
            if (err.code === 'ENOENT') {
                logger.warn(`persona.md not found at ${config.personaFile} — using the built-in fallback persona`);
            } else {
                logger.error(`Could not read persona.md: ${err.message}`);
            }
        }
        return this;
    }

    /** Reload on edit, debounced -- editors often fire several events per save. */
    watchForChanges() {
        try {
            let timer = null;
            this.#watcher = watch(config.personaFile, () => {
                clearTimeout(timer);
                timer = setTimeout(async () => {
                    await this.load();
                    logger.info(`persona.md reloaded (v${this.#version}, ${this.#text.length} chars)`);
                }, 300);
                timer.unref?.();
            });
            this.#watcher.on('error', (err) => logger.warn(`persona.md watch stopped: ${err.message}`));
            logger.info(`Watching ${path.basename(config.personaFile)} for live edits`);
        } catch (err) {
            logger.debug(`persona.md watch unavailable: ${err.message}`);
        }
        return this;
    }

    get text() {
        return this.#text;
    }

    get version() {
        return this.#version;
    }

    close() {
        this.#watcher?.close();
        this.#watcher = null;
    }
}
