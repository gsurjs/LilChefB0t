import { ApiClient } from '@twurple/api';
import { logger } from '../logger.js';
import { config } from '../config.js';

/** Short TTLs: fresh enough to be correct, long enough that chat spam cannot hammer Helix. */
const STREAM_TTL_MS = 30_000;
const CHANNEL_TTL_MS = 60_000;
const CLIPS_TTL_MS = 120_000;

class Cached {
    #value = null;
    #at = 0;
    #ttl;
    #inflight = null;

    constructor(ttl) {
        this.#ttl = ttl;
    }

    async get(loader) {
        if (this.#value !== null && Date.now() - this.#at < this.#ttl) return this.#value;
        // Collapse concurrent misses into one Helix call.
        this.#inflight ??= loader()
            .then((value) => {
                this.#value = value;
                this.#at = Date.now();
                return value;
            })
            .finally(() => {
                this.#inflight = null;
            });
        return this.#inflight;
    }

    invalidate() {
        this.#value = null;
    }
}

/**
 * Everything the bot needs from Helix.
 *
 * Moderation lives here rather than in the chat layer because Twitch removed IRC
 * chat commands in February 2023 -- `/ban` in a chat message has not worked for
 * years, it just posts the text. These are real REST calls.
 */
export class TwitchApi {
    #api;
    #authProvider;
    #broadcasterId = null;
    #botId = null;
    #streamCache = new Cached(STREAM_TTL_MS);
    #channelCache = new Cached(CHANNEL_TTL_MS);
    #clipsCache = new Cached(CLIPS_TTL_MS);

    #knownUserIds;

    /**
     * @param authProvider  The refreshing provider backing Helix.
     * @param knownUserIds  Every user the provider has a token for. Used to find
     *   whichever account actually holds a scope, rather than assuming it is the
     *   bot or the broadcaster -- a moderator's token is a perfectly good third
     *   option, and sometimes the only one available.
     */
    constructor(authProvider, { knownUserIds = [], apiClient } = {}) {
        this.#authProvider = authProvider;
        this.#api = apiClient ?? new ApiClient({ authProvider });
        this.#knownUserIds = knownUserIds;
    }

    /**
     * A user whose token can authorize a plain Helix read.
     *
     * Twurple sends any call made outside a user context with an *app* access
     * token, and minting one needs a client secret -- which a Public app does
     * not have. So even scope-free reads like "look up this username" have to
     * name a user. Preference mirrors findHolder(): bot, broadcaster, then any
     * other authorized account.
     */
    get contextUserId() {
        for (const userId of [this.#botId, this.#broadcasterId, ...this.#knownUserIds]) {
            if (userId && this.knows(userId)) return userId;
        }
        return null;
    }

    /** Run a Helix call under a user token rather than an app token. */
    async #withUser(runner) {
        const userId = this.contextUserId;
        if (!userId) {
            throw new Error(
                'No Twitch user token is available for API calls. Run `npm run auth`, ' +
                    'or set one of BOT_/BROADCASTER_/MODERATOR_REFRESH_TOKEN.'
            );
        }
        return this.#api.asUser(userId, runner);
    }

    get client() {
        return this.#api;
    }

    get broadcasterId() {
        return this.#broadcasterId;
    }

    get botId() {
        return this.#botId;
    }

    async init() {
        const [broadcaster, bot] = await this.#withUser((ctx) =>
            Promise.all([
                ctx.users.getUserByName(config.twitch.channelName),
                ctx.users.getUserByName(config.twitch.botUsername)
            ])
        );

        if (!broadcaster) throw new Error(`Twitch has no user named "${config.twitch.channelName}" (CHANNEL_NAME)`);
        if (!bot) throw new Error(`Twitch has no user named "${config.twitch.botUsername}" (BOT_USERNAME)`);

        this.#broadcasterId = broadcaster.id;
        this.#botId = bot.id;
        logger.info(`Resolved channel ${broadcaster.displayName} (${broadcaster.id}), bot ${bot.displayName} (${bot.id})`);
        return this;
    }

    /** Scopes currently held by a user's token, for feature gating. */
    scopesFor(userId) {
        try {
            return this.#authProvider.getCurrentScopesForUser(userId);
        } catch {
            return [];
        }
    }

    hasScope(userId, scope) {
        return this.scopesFor(userId).includes(scope);
    }

    /** Whether the provider holds a token for this user at all. */
    knows(userId) {
        if (!userId) return false;
        // A refreshing provider tracks users and can be asked directly.
        if (typeof this.#authProvider.hasUser === 'function') return this.#authProvider.hasUser(userId);
        // A static provider serves exactly one user: the one we were handed.
        return this.#knownUserIds.includes(userId);
    }

    /**
     * The user ID of whichever authorized account holds `scope`, or null.
     *
     * Preference order is bot, then broadcaster, then any other account (a
     * moderator). The bot first so it acts as itself where it can; a moderator
     * last because it is the fallback, not the intent -- but a perfectly valid
     * one, since Helix checks the scope on the token rather than caring which
     * role the human thinks it plays.
     */
    findHolder(scope) {
        const candidates = [this.#botId, this.#broadcasterId, ...this.#knownUserIds];
        for (const userId of candidates) {
            if (userId && this.hasScope(userId, scope)) return userId;
        }
        return null;
    }

    /**
     * Run a Helix call that needs a token carrying `scope`.
     *
     * Twurple defaults these endpoints to the broadcaster's token, so the user
     * context has to be set explicitly to whichever account actually holds it.
     */
    async #asModerator(scope, runner) {
        const userId = this.findHolder(scope);
        if (!userId) {
            throw new Error(
                `No authorized token holds "${scope}". Re-run \`npm run auth\` and approve it ` +
                    'for an account that moderates this channel.'
            );
        }
        return this.#api.asUser(userId, runner);
    }

    // ---------------------------------------------------------------- read side

    async getStreamStatus() {
        return this.#streamCache.get(async () => {
            const stream = await this.#withUser((ctx) => ctx.streams.getStreamByUserId(this.#broadcasterId));
            if (!stream) return { live: false };
            return {
                live: true,
                game: stream.gameName,
                title: stream.title,
                viewers: stream.viewers,
                startedAt: stream.startDate,
                uptimeMinutes: Math.floor((Date.now() - stream.startDate.getTime()) / 60_000)
            };
        });
    }

    async getChannelInfo() {
        return this.#channelCache.get(async () => {
            const channel = await this.#withUser((ctx) => ctx.channels.getChannelInfoById(this.#broadcasterId));
            if (!channel) return null;
            return { game: channel.gameName, title: channel.title, tags: channel.tags, language: channel.language };
        });
    }

    /** Returns the follow date, or null if they do not follow / the scope is missing. */
    async getFollowage(userName) {
        const target = userName.replace(/^@/, '').toLowerCase();
        const user = await this.#withUser((ctx) => ctx.users.getUserByName(target));
        if (!user) return { found: false };

        const result = await this.#asModerator('moderator:read:followers', (ctx) =>
            ctx.channels.getChannelFollowers(this.#broadcasterId, user.id)
        );
        const follow = result.data[0];
        if (!follow) return { found: true, following: false, displayName: user.displayName };

        return {
            found: true,
            following: true,
            displayName: user.displayName,
            since: follow.followDate,
            days: Math.floor((Date.now() - follow.followDate.getTime()) / 86_400_000)
        };
    }

    async getRecentClips(count = 3) {
        const clips = await this.#clipsCache.get(async () => {
            const result = await this.#withUser((ctx) =>
                ctx.clips.getClipsForBroadcaster(this.#broadcasterId, { limit: 10 })
            );
            return result.data.map((clip) => ({
                title: clip.title,
                url: clip.url,
                creator: clip.creatorDisplayName,
                views: clip.views,
                createdAt: clip.creationDate
            }));
        });
        return clips.slice(0, Math.max(1, Math.min(count, 5)));
    }

    /** Last played category, for shoutouts. Works whether or not they are live. */
    async getShoutoutInfo(userName) {
        const target = userName.replace(/^@/, '').toLowerCase();
        const user = await this.#withUser((ctx) => ctx.users.getUserByName(target));
        if (!user) return null;

        const [channel, stream] = await this.#withUser((ctx) =>
            Promise.all([ctx.channels.getChannelInfoById(user.id), ctx.streams.getStreamByUserId(user.id)])
        );
        return {
            displayName: user.displayName,
            name: user.name,
            game: channel?.gameName || null,
            title: channel?.title || null,
            live: Boolean(stream)
        };
    }

    // ----------------------------------------------------------- moderation side

    async #resolveTarget(userName) {
        const clean = userName.replace(/^@/, '').toLowerCase();
        const user = await this.#withUser((ctx) => ctx.users.getUserByName(clean));
        if (!user) throw new Error(`No Twitch user named "${clean}"`);
        return user;
    }

    /** Permanent ban. `duration` is handled by timeoutUser instead. */
    async banUser(userName, reason = '') {
        const target = await this.#resolveTarget(userName);
        await this.#asModerator('moderator:manage:banned_users', (ctx) =>
            ctx.moderation.banUser(this.#broadcasterId, { user: target.id, reason: reason || undefined })
        );
        return target;
    }

    async timeoutUser(userName, seconds, reason = '') {
        const target = await this.#resolveTarget(userName);
        await this.#asModerator('moderator:manage:banned_users', (ctx) =>
            ctx.moderation.banUser(this.#broadcasterId, {
                user: target.id,
                duration: seconds,
                reason: reason || undefined
            })
        );
        return target;
    }

    async unbanUser(userName) {
        const target = await this.#resolveTarget(userName);
        await this.#asModerator('moderator:manage:banned_users', (ctx) =>
            ctx.moderation.unbanUser(this.#broadcasterId, target.id)
        );
        return target;
    }

    /** Omit `messageId` to clear the whole chat. */
    async clearChat(messageId) {
        await this.#asModerator('moderator:manage:chat_messages', (ctx) =>
            ctx.moderation.deleteChatMessages(this.#broadcasterId, messageId)
        );
    }
}
