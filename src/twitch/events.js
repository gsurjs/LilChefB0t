import { EventSubWsListener } from '@twurple/eventsub-ws';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { pick, plural } from '../util.js';

/**
 * Stream event reactions, from two sources.
 *
 * **Chat (IRC USERNOTICE)** carries raids, subs, resubs, gift subs and cheers.
 * It needs no scopes beyond the chat connection itself, so it works for anyone
 * who can run the bot at all -- including the case where you develop for
 * someone else's channel and will never hold the broadcaster's token.
 *
 * **EventSub** adds only what chat cannot express: stream online/offline and
 * follows. Twurple picks the token per subscription type from its `authUserId`,
 * and for online/offline that is the broadcaster, so those are skipped unless
 * the broadcaster is authorized. Follows authorize as the moderator, so they
 * work from a moderator token.
 *
 * Preferring chat is not a workaround. It is fewer scopes, fewer moving parts,
 * and no dependency on an account you might not control.
 */
export class EventBridge {
    #listener = null;
    #twitchApi;
    #chat;
    #ai;
    #state;
    #active = [];

    constructor({ twitchApi, chat, ai, state }) {
        this.#twitchApi = twitchApi;
        this.#chat = chat;
        this.#ai = ai;
        this.#state = state;
    }

    get activeNames() {
        return this.#active;
    }

    /**
     * Say something about an event.
     *
     * The AI path gets one sentence of context and no tools. If it is disabled,
     * over budget, or declines, the static template runs instead -- a raid
     * should never go unacknowledged because of an API hiccup.
     */
    async #announce({ instruction, fallback }) {
        if (config.ai.eventReactions && this.#state.aiEnabled) {
            const result = await this.#ai.reactToEvent(instruction);
            if (result.ok && result.text) {
                await this.#chat.say(result.text);
                return;
            }
        }
        await this.#chat.say(fallback);
    }

    /** Wrap a handler so one bad reaction cannot take the process down. */
    #safely(name, handler) {
        return async (...args) => {
            try {
                await handler(...args);
            } catch (err) {
                logger.error(`Reaction to "${name}" failed:`, err);
            }
        };
    }

    // ----------------------------------------------------------- chat sourced

    /** Raids, subs and cheers over IRC. No scopes required. */
    #startChatEvents() {
        const client = this.#chat.client;

        client.onRaid(
            this.#safely('raid', async (_channel, _user, info) => {
                logger.info(`RAID from ${info.displayName} with ${info.viewerCount} viewers`);

                // Look up what they stream so the shoutout says something real.
                const about = await this.#twitchApi.getShoutoutInfo(info.displayName).catch(() => null);
                const theyPlay = about?.game ? ` They were last streaming ${about.game}.` : '';
                const link = about?.name ?? info.displayName.toLowerCase();

                await this.#announce({
                    instruction:
                        `${info.displayName} just raided the channel with ${plural(info.viewerCount, 'viewer')}.` +
                        `${theyPlay} Welcome the raiders warmly and tell chat to go follow them.`,
                    fallback:
                        `🚨 RAID! ${info.displayName} brought ${plural(info.viewerCount, 'viewer')}! ` +
                        `Go show them love: https://twitch.tv/${link}`
                });
            })
        );

        client.onSub(
            this.#safely('sub', async (_channel, _user, info) => {
                logger.info(`SUB from ${info.displayName} (${info.planName ?? info.plan})`);
                await this.#announce({
                    instruction:
                        `${info.displayName} just subscribed for the first time` +
                        `${info.isPrime ? ' with Prime' : ''}. Thank them.`,
                    fallback: `💜 Welcome to the kitchen, ${info.displayName}! Thanks for subscribing!`
                });
            })
        );

        client.onResub(
            this.#safely('resub', async (_channel, _user, info) => {
                logger.info(`RESUB from ${info.displayName} (${info.months} months)`);
                const streak = info.streak ? ` They are on a ${info.streak}-month streak.` : '';
                const said = info.message ? ` They said: "${info.message}"` : '';

                await this.#announce({
                    instruction:
                        `${info.displayName} resubscribed for month ${info.months}.${streak}${said} ` +
                        'Thank them, and react to what they said if they said anything.',
                    fallback: `💜 ${info.displayName} has been here ${plural(info.months, 'month')}! Thank you!`
                });
            })
        );

        client.onSubGift(
            this.#safely('subgift', async (_channel, _user, info) => {
                // A community gift fires onCommunitySub plus one onSubGift per
                // recipient. Announcing both would spam chat, so the bulk event
                // owns the announcement and the individual ones stay quiet.
                if (info.gifterGiftCount && info.gifterGiftCount > 1) return;

                const gifter = info.gifterDisplayName ?? 'An anonymous chef';
                logger.info(`SUBGIFT ${gifter} -> ${info.displayName}`);
                await this.#announce({
                    instruction: `${gifter} just gifted a subscription to ${info.displayName}. Thank the gifter.`,
                    fallback: `🎁 ${gifter} gifted a sub to ${info.displayName}! Legend!`
                });
            })
        );

        client.onCommunitySub(
            this.#safely('communitysub', async (_channel, _user, info) => {
                const gifter = info.gifterDisplayName ?? 'An anonymous chef';
                logger.info(`COMMUNITY SUB ${gifter} x${info.count}`);
                await this.#announce({
                    instruction: `${gifter} just gifted ${plural(info.count, 'subscription')} to the channel. Thank them.`,
                    fallback: `🎁 ${gifter} dropped ${plural(info.count, 'sub')} on the channel! Absolute legend!`
                });
            })
        );

        this.#active.push('raid', 'sub', 'resub', 'subgift', 'communitysub');

        // Cheers are ordinary chat messages carrying bits, so they are handled
        // in the message pipeline rather than here. See handleCheer().
        if (config.ai.cheerThreshold > 0) this.#active.push('cheer');
    }

    /**
     * Called from the message pipeline for any message carrying bits.
     * Returns true when it announced, so the caller can skip other handling.
     */
    async handleCheer(msg, user) {
        const bits = msg.bits ?? 0;
        if (bits < config.ai.cheerThreshold) return false;

        logger.info(`CHEER ${bits} bits from ${user.displayName}`);
        await this.#announce({
            instruction: `${user.displayName} just cheered ${plural(bits, 'bit')}. Thank them in one short line.`,
            fallback: `✨ ${user.displayName} dropped ${plural(bits, 'bit')}! Thank you!`
        });
        return true;
    }

    // -------------------------------------------------------- EventSub sourced

    #startEventSub() {
        const channelId = this.#twitchApi.broadcasterId;

        // Twurple authorizes stream.online/offline as the broadcaster, so there
        // is no point attempting them without that account's token.
        const broadcasterAuthorized = this.#twitchApi.knows(channelId);

        // Follows authorize as the moderator, which a mod token satisfies.
        const followAuth = this.#twitchApi.findHolder('moderator:read:followers');

        if (!broadcasterAuthorized && !followAuth) {
            logger.info(
                'EventSub skipped entirely: stream online/offline needs the broadcaster token, ' +
                    'and follows need moderator:read:followers. Chat-based alerts are unaffected.'
            );
            return;
        }

        this.#listener = new EventSubWsListener({ apiClient: this.#twitchApi.client });

        this.#listener.onSubscriptionCreateSuccess((sub) => logger.debug(`EventSub ready: ${sub.id}`));
        this.#listener.onSubscriptionCreateFailure((sub, error) =>
            // Twitch refuses these asynchronously, so this is the only place a
            // rejected subscription becomes visible.
            logger.warn(`EventSub subscription refused (${sub.id}): ${error.message}`)
        );

        if (broadcasterAuthorized) {
            this.#listener.onStreamOnline(channelId, (event) => {
                logger.info(`Stream went ONLINE (${event.startDate?.toISOString?.() ?? 'now'})`);
                this.#state.streamLive = true;
            });
            this.#listener.onStreamOffline(channelId, () => {
                logger.info('Stream went OFFLINE');
                this.#state.streamLive = false;
            });
            this.#active.push('stream.online', 'stream.offline');
        } else {
            logger.info('EventSub: stream online/offline skipped (needs the broadcaster account authorized)');
        }

        if (followAuth) {
            this.#listener.onChannelFollow(
                channelId,
                followAuth,
                this.#safely('follow', async (event) => {
                    logger.info(`FOLLOW from ${event.userDisplayName}`);
                    // Template-only on purpose: follows arrive in bursts, and an
                    // API call per follow is a good way to burn the daily budget.
                    await this.#chat.say(
                        pick([
                            `👋 Thanks for the follow, ${event.userDisplayName}! Pull up a stool.`,
                            `🧑🏻‍🍳 ${event.userDisplayName} joined the kitchen staff. Welcome!`,
                            `💜 Welcome in, ${event.userDisplayName}!`
                        ])
                    );
                })
            );
            this.#active.push('follow');
        } else {
            logger.info('EventSub: follows skipped (needs moderator:read:followers)');
        }

        this.#listener.start();
    }

    start() {
        this.#startChatEvents();
        try {
            this.#startEventSub();
        } catch (err) {
            // EventSub is the optional half; chat alerts must survive its failure.
            logger.error(`EventSub failed to start, continuing without it: ${err.message}`);
        }
        logger.info(`Event reactions active: ${this.#active.join(', ')}`);
        return this;
    }

    stop() {
        try {
            this.#listener?.stop();
        } catch (err) {
            logger.debug(`EventSub stop error (ignored): ${err.message}`);
        }
    }
}
