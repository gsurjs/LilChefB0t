import { logger } from './logger.js';
import { config } from './config.js';
import { socialsLine } from './commands/social.js';

/**
 * Periodic socials posting.
 *
 * Off by default, and it also checks that the stream is actually live before
 * posting -- the old version happily advertised to an empty offline channel for
 * as long as the process stayed up.
 */
export class AutoPoster {
    #timer = null;
    #chat;
    #twitchApi;
    #enabled = false;

    constructor({ chat, twitchApi }) {
        this.#chat = chat;
        this.#twitchApi = twitchApi;
    }

    get isEnabled() {
        return this.#enabled;
    }

    start() {
        this.stop();
        this.#enabled = true;
        this.#timer = setInterval(() => void this.#post(), config.autopost.intervalMs);
        this.#timer.unref?.();
        logger.info(`Auto-posting enabled (every ${config.autopost.intervalMs / 60_000} minutes, live streams only)`);
        return this;
    }

    async #post() {
        if (!this.#enabled) return;
        try {
            const status = await this.#twitchApi.getStreamStatus();
            if (!status.live) {
                logger.debug('Skipped autopost — stream is offline');
                return;
            }
            await this.#chat.say(socialsLine());
            logger.info('Auto-posted socials');
        } catch (err) {
            logger.warn(`Autopost failed: ${err.message}`);
        }
    }

    stop() {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.#enabled = false;
    }
}
