import { ChatClient } from '@twurple/chat';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { chunkMessage } from '../ai/sanitize.js';

const CONNECT_TIMEOUT_MS = 20_000;

/**
 * The chat connection.
 *
 * Twurple handles Twitch's message rate limits internally, which the old
 * tmi.js setup did not, and `replyTo` threads a response under the message that
 * triggered it -- something IRC could not express at all.
 */
export class ChatBridge {
    #client;
    #channel;
    #messageHandlers = [];
    #duplicateWarned = false;

    /** `client` is only passed by tests; production builds its own. */
    constructor(authProvider, { client } = {}) {
        this.#channel = config.twitch.channelName;
        this.#client = client ?? new ChatClient({
            authProvider,
            channels: [this.#channel],
            // Resolve `channels` once; Twurple rejoins on reconnect by itself.
            rejoinChannelsOnReconnect: true,
            requestMembershipEvents: false
        });
        this.#wireLifecycle();
    }

    get client() {
        return this.#client;
    }

    get channel() {
        return this.#channel;
    }

    get isConnected() {
        return this.#client.isConnected;
    }

    #wireLifecycle() {
        this.#client.onConnect(() => logger.info('Chat connected'));
        this.#client.onDisconnect((manually, reason) => {
            if (manually) logger.info('Chat disconnected (requested)');
            else logger.warn(`Chat disconnected: ${reason?.message ?? 'unknown reason'} — Twurple will reconnect`);
        });
        this.#client.onJoin((channel) => logger.info(`Joined ${channel}`));
        this.#client.onJoinFailure((channel, reason) => logger.error(`Could not join ${channel}: ${reason}`));
        this.#client.onAuthenticationFailure((text, retryCount) =>
            logger.error(`Chat auth failed (attempt ${retryCount}): ${text}`)
        );
        this.#client.onTokenFetchFailure((error) => logger.error(`Could not fetch a chat token: ${error.message}`));
        this.#client.onMessageFailed((channel, reason) => logger.warn(`Message to ${channel} rejected: ${reason}`));
        this.#client.onMessageRatelimit((channel) => logger.warn(`Rate limited in ${channel} — message dropped`));
        this.#client.onNoPermission((channel, text) => logger.warn(`No permission in ${channel}: ${text}`));
    }

    /** Resolves once chat is actually connected, or rejects on timeout. */
    connect() {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(`Chat did not connect within ${CONNECT_TIMEOUT_MS / 1000}s`)),
                CONNECT_TIMEOUT_MS
            );
            timer.unref?.();

            // Both listeners are one-shot: whichever fires first unbinds the pair,
            // so neither lingers past the initial connect.
            const settle = (fn) => {
                clearTimeout(timer);
                connected.unbind();
                failed.unbind();
                fn();
            };
            const connected = this.#client.onConnect(() => settle(resolve));
            const failed = this.#client.onAuthenticationFailure((text) =>
                settle(() => reject(new Error(`Twitch rejected the bot's chat credentials: ${text}`)))
            );

            this.#client.connect();
        });
    }

    onMessage(handler) {
        this.#messageHandlers.push(handler);
        if (this.#messageHandlers.length === 1) {
            this.#client.onMessage(async (channel, username, text, msg) => {
                // Twitch does not echo a message back to the connection that
                // sent it. So a message from our own account can only have come
                // from a *second* connection -- another instance of this bot,
                // which is why chat would be answering everything twice.
                if (username.toLowerCase() === config.twitch.botUsername && !this.#duplicateWarned) {
                    this.#duplicateWarned = true;
                    logger.error(
                        `Saw a chat message from our own account (${username}) that this process did ` +
                            'not send. Another instance of the bot is connected and every command will ' +
                            'be answered twice. Check for a second service, extra replicas, or an old ' +
                            'deployment still running, and stop one of them.'
                    );
                }

                // Never act on our own output, however many instances there are.
                if (username.toLowerCase() === config.twitch.botUsername) return;

                for (const fn of this.#messageHandlers) {
                    try {
                        await fn({ channel, username, text, msg });
                    } catch (err) {
                        logger.error('Message handler threw:', err);
                    }
                }
            });
        }
    }

    /** True once a message from our own account has been observed. */
    get sawDuplicateInstance() {
        return this.#duplicateWarned;
    }

    /** Send a message, split into chat-safe chunks. */
    async say(text) {
        for (const chunk of chunkMessage(text, { maxChunks: 3 })) {
            await this.#client.say(this.#channel, chunk);
        }
    }

    /** Send a message threaded under `msg`, so answers stay attached to questions. */
    async reply(text, msg) {
        const chunks = chunkMessage(text, { maxChunks: 3 });
        for (const [index, chunk] of chunks.entries()) {
            // Only the first chunk threads; Twitch shows the rest beneath it anyway.
            await this.#client.say(this.#channel, chunk, index === 0 && msg ? { replyTo: msg } : undefined);
        }
    }

    quit() {
        try {
            this.#client.quit();
        } catch (err) {
            logger.debug(`Chat quit error (ignored): ${err.message}`);
        }
    }
}
