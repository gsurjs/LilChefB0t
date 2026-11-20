import { EventSubWsListener } from '@twurple/eventsub-ws';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { pick, plural } from '../util.js';

/**
 * Stream events, over EventSub WebSockets.
 *
 * None of this was reachable from the old IRC-only bot. Twitch's investment in
 * new chat and channel features goes to EventSub and Helix, so raids, subs,
 * cheers and follows only arrive here.
 *
 * Each subscription is gated on the scopes we actually hold. Raids and stream
 * online/offline need none, so they work with just the bot account authorized;
 * subs and cheers need the broadcaster's own token and are skipped (loudly, with
 * the missing scope named) when it is absent.
 */
export class EventBridge {
    #listener;
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
        this.#listener = new EventSubWsListener({ apiClient: twitchApi.client });
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

    /** Register one subscription, tolerating failures so one bad scope cannot stop the rest. */
    #add(name, requirement, subscribe) {
        if (requirement && !requirement.ok) {
            logger.warn(`EventSub "${name}" skipped — needs ${requirement.scope} on the ${requirement.who} account`);
            return;
        }
        try {
            subscribe();
            this.#active.push(name);
        } catch (err) {
            logger.error(`EventSub "${name}" failed to subscribe: ${err.message}`);
        }
    }

    #needs(scope, { allowBot = false } = {}) {
        const broadcasterId = this.#twitchApi.broadcasterId;
        const botId = this.#twitchApi.botId;

        if (this.#twitchApi.hasScope(broadcasterId, scope)) {
            return { ok: true, userId: broadcasterId, scope, who: 'broadcaster' };
        }
        if (allowBot && this.#twitchApi.hasScope(botId, scope)) {
            return { ok: true, userId: botId, scope, who: 'bot' };
        }
        return { ok: false, scope, who: allowBot ? 'broadcaster or bot' : 'broadcaster' };
    }

    start() {
        const channelId = this.#twitchApi.broadcasterId;

        // --- No scope required -------------------------------------------------

        this.#add('raid', null, () =>
            this.#listener.onChannelRaidTo(channelId, async (event) => {
                logger.info(`RAID from ${event.raidingBroadcasterDisplayName} with ${event.viewers} viewers`);
                const info = await this.#twitchApi.getShoutoutInfo(event.raidingBroadcasterName).catch(() => null);
                const theyPlay = info?.game ? ` They were last streaming ${info.game}.` : '';

                await this.#announce({
                    instruction:
                        `${event.raidingBroadcasterDisplayName} just raided the channel with ` +
                        `${plural(event.viewers, 'viewer')}.${theyPlay} ` +
                        'Welcome the raiders warmly and tell chat to go follow them.',
                    fallback:
                        `🚨 RAID! ${event.raidingBroadcasterDisplayName} brought ${plural(event.viewers, 'viewer')}! ` +
                        `Go show them love: https://twitch.tv/${event.raidingBroadcasterName}`
                });
            })
        );

        this.#add('stream.online', null, () =>
            this.#listener.onStreamOnline(channelId, async (event) => {
                logger.info(`Stream went ONLINE (${event.startDate?.toISOString?.() ?? 'now'})`);
                this.#state.streamLive = true;
            })
        );

        this.#add('stream.offline', null, () =>
            this.#listener.onStreamOffline(channelId, () => {
                logger.info('Stream went OFFLINE');
                this.#state.streamLive = false;
            })
        );

        // --- Broadcaster token required ----------------------------------------

        const subsScope = this.#needs('channel:read:subscriptions');

        this.#add('subscribe', subsScope, () =>
            this.#listener.onChannelSubscription(channelId, async (event) => {
                // Gift recipients are announced by the gift event instead, so a
                // gifted sub does not get two messages.
                if (event.isGift) return;
                logger.info(`SUB from ${event.userDisplayName} (tier ${event.tier})`);
                await this.#announce({
                    instruction: `${event.userDisplayName} just subscribed for the first time. Thank them.`,
                    fallback: `💜 Welcome to the kitchen, ${event.userDisplayName}! Thanks for subscribing!`
                });
            })
        );

        this.#add('resub', subsScope, () =>
            this.#listener.onChannelSubscriptionMessage(channelId, async (event) => {
                logger.info(`RESUB from ${event.userDisplayName} (${event.cumulativeMonths} months)`);
                const streak = event.streakMonths ? ` They are on a ${event.streakMonths}-month streak.` : '';
                const said = event.messageText ? ` They said: "${event.messageText}"` : '';

                await this.#announce({
                    instruction:
                        `${event.userDisplayName} resubscribed for month ${event.cumulativeMonths}.${streak}${said} ` +
                        'Thank them and react to what they said if they said anything.',
                    fallback: `💜 ${event.userDisplayName} has been here ${plural(
                        event.cumulativeMonths,
                        'month'
                    )}! Thank you!`
                });
            })
        );

        this.#add('subgift', subsScope, () =>
            this.#listener.onChannelSubscriptionGift(channelId, async (event) => {
                const gifter = event.isAnonymous ? 'An anonymous chef' : event.gifterDisplayName;
                logger.info(`SUBGIFT x${event.amount} from ${gifter}`);
                await this.#announce({
                    instruction: `${gifter} just gifted ${plural(event.amount, 'subscription')} to the channel. Thank them.`,
                    fallback: `🎁 ${gifter} gifted ${plural(event.amount, 'sub')}! Absolute legend!`
                });
            })
        );

        this.#add('cheer', this.#needs('bits:read'), () =>
            this.#listener.onChannelCheer(channelId, async (event) => {
                const who = event.isAnonymous ? 'An anonymous chef' : event.userDisplayName;
                logger.info(`CHEER ${event.bits} bits from ${who}`);
                await this.#announce({
                    instruction:
                        `${who} just cheered ${plural(event.bits, 'bit')}. ` +
                        (event.message ? `Their message: "${event.message}". ` : '') +
                        'Thank them.',
                    fallback: `✨ ${who} dropped ${plural(event.bits, 'bit')}! Thank you!`
                });
            })
        );

        // Follows accept a moderator token, so the bot can cover this one.
        const followScope = this.#needs('moderator:read:followers', { allowBot: true });
        this.#add('follow', followScope, () =>
            this.#listener.onChannelFollow(channelId, followScope.userId, async (event) => {
                logger.info(`FOLLOW from ${event.userDisplayName}`);
                // Deliberately template-only: follows arrive in bursts, and an
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

        this.#listener.start();

        if (this.#active.length === 0) {
            logger.warn('EventSub started with no active subscriptions');
        } else {
            logger.info(`EventSub active: ${this.#active.join(', ')}`);
        }
        return this;
    }

    stop() {
        try {
            this.#listener.stop();
        } catch (err) {
            logger.debug(`EventSub stop error (ignored): ${err.message}`);
        }
    }
}
