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

    constructor(authProvider) {
        this.#authProvider = authProvider;
        this.#api = new ApiClient({ authProvider });
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
        const [broadcaster, bot] = await Promise.all([
            this.#api.users.getUserByName(config.twitch.channelName),
            this.#api.users.getUserByName(config.twitch.botUsername)
        ]);

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

    /**
     * Run a Helix call that needs a moderator token.
     *
     * Twurple defaults these endpoints to the broadcaster's token. The bot is
     * normally the moderator, so prefer its context and fall back to the
     * broadcaster only when the bot lacks the scope.
     */
    async #asModerator(scope, runner) {
        if (this.#botId && this.hasScope(this.#botId, scope)) {
            return this.#api.asUser(this.#botId, runner);
        }
        if (this.#broadcasterId && this.hasScope(this.#broadcasterId, scope)) {
            return this.#api.asUser(this.#broadcasterId, runner);
        }
        throw new Error(
            `No authorized token holds "${scope}". Re-run \`npm run auth\` and approve it for the bot account.`
        );
    }

    // ---------------------------------------------------------------- read side

    async getStreamStatus() {
        return this.#streamCache.get(async () => {
            const stream = await this.#api.streams.getStreamByUserId(this.#broadcasterId);
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
            const channel = await this.#api.channels.getChannelInfoById(this.#broadcasterId);
            if (!channel) return null;
            return { game: channel.gameName, title: channel.title, tags: channel.tags, language: channel.language };
        });
    }

    /** Returns the follow date, or null if they do not follow / the scope is missing. */
    async getFollowage(userName) {
        const user = await this.#api.users.getUserByName(userName.replace(/^@/, '').toLowerCase());
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
            const result = await this.#api.clips.getClipsForBroadcaster(this.#broadcasterId, { limit: 10 });
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
        const user = await this.#api.users.getUserByName(userName.replace(/^@/, '').toLowerCase());
        if (!user) return null;
        const [channel, stream] = await Promise.all([
            this.#api.channels.getChannelInfoById(user.id),
            this.#api.streams.getStreamByUserId(user.id)
        ]);
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
        const user = await this.#api.users.getUserByName(clean);
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
