import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '..');

const str = (name, fallback = '') => (process.env[name] ?? fallback).trim();
const num = (name, fallback) => {
    const raw = str(name);
    if (!raw) return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
};
const bool = (name, fallback) => {
    const raw = str(name).toLowerCase();
    if (!raw) return fallback;
    return ['1', 'true', 'yes', 'on', 'enabled'].includes(raw);
};
const list = (name) =>
    str(name)
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);

/** Strip a `#` prefix and lowercase, so `#RogueDubz` and `roguedubz` both work. */
const channelName = str('CHANNEL_NAME').replace(/^#/, '').toLowerCase();

export const config = {
    twitch: {
        clientId: str('TWITCH_CLIENT_ID'),
        clientSecret: str('TWITCH_CLIENT_SECRET'),
        botUsername: str('BOT_USERNAME').toLowerCase(),
        channelName,
        authorizedUsers: list('AUTHORIZED_USERS'),

        /**
         * A static chat token for the bot account, used for chat only.
         *
         * This exists for the case where you control the channel but not the bot
         * account's login -- a generator token from v1 still authenticates chat
         * fine, so the bot keeps its own name in chat while Helix and EventSub
         * run on the broadcaster's refreshing token. `OAUTH_TOKEN` is read as a
         * fallback so an existing v1 deployment needs no new variable.
         *
         * It cannot refresh. If Twitch ever revokes it, chat stops and you will
         * need the bot account's login (or switch to running as the broadcaster).
         */
        botChatToken: str('BOT_CHAT_TOKEN') || str('OAUTH_TOKEN'),

        /**
         * A static token authorizing Twitch API calls, in place of a refreshing one.
         *
         * Device-code refresh tokens are single-use, so seeding one through an
         * environment variable only works if the rotated replacement lands on
         * durable storage -- which makes a persistent volume mandatory, and
         * makes a missing volume fail in a confusing way one deploy later.
         *
         * An implicit-grant token sidesteps all of it: no refresh token to
         * rotate, nothing to persist, no volume required. It needs no client
         * secret and works with a Public app. `npm run auth` can mint one.
         *
         * Whoever authorizes it must moderate the channel for the moderation
         * scopes to do anything.
         */
        apiToken: str('TWITCH_API_TOKEN')
    },

    ai: {
        apiKey: str('ANTHROPIC_API_KEY'),
        // Verified against platform.claude.com: dateless IDs are pinned snapshots.
        model: str('CLAUDE_MODEL', 'claude-sonnet-5-5'),
        // Sonnet 5.5 defaults to `high`; chat wants latency, so step down.
        effort: str('CLAUDE_EFFORT', 'low'),
        maxTokens: num('CLAUDE_MAX_TOKENS', 1024),
        enabledAtBoot: bool('AI_ENABLED', true),
        // Per-user cooldown on !chefbot.
        cooldownMs: num('AI_COOLDOWN_MS', 10_000),
        // Hard ceiling so a troll with a stopwatch can't run up a bill.
        dailyUsdCap: num('AI_DAILY_USD_CAP', 2),
        // Rolling chat lines handed to Claude as context.
        memoryWindow: num('AI_MEMORY_WINDOW', 25),
        // Reply when chat says the bot's name, not just on !chefbot.
        respondToMentions: bool('AI_RESPOND_TO_MENTIONS', true),
        mentionCooldownMs: num('AI_MENTION_COOLDOWN_MS', 30_000),
        // AI-written raid/sub/cheer shoutouts (falls back to templates when off).
        eventReactions: bool('AI_EVENT_REACTIONS', true),

        // Minimum bits before the bot reacts to a cheer. Cheers arrive as
        // ordinary chat messages, so without a floor every 1-bit emote in a
        // busy chat would trigger a reaction. 0 disables cheer reactions.
        cheerThreshold: num('AI_CHEER_THRESHOLD', 100)
    },

    socials: {
        discord: str('DISCORD_INVITE'),
        twitter: str('TWITTER_HANDLE'),
        youtube: str('YOUTUBE_CHANNEL')
    },

    autopost: {
        enabledAtBoot: bool('AUTOPOST_ENABLED', false),
        intervalMs: num('AUTOPOST_INTERVAL_MS', 10 * 60 * 1000)
    },

    port: num('PORT', 3000),

    /**
     * Where tokens, the spend ledger and viewer notes live.
     *
     * Must survive restarts: device-code refresh tokens are single-use, so a
     * container that comes back with a stale copy would try to redeem a spent
     * token. Railway sets RAILWAY_VOLUME_MOUNT_PATH for an attached volume, so
     * honouring it means the deploy works without extra configuration.
     */
    dataDir: str('DATA_DIR') || str('RAILWAY_VOLUME_MOUNT_PATH') || path.join(projectRoot, 'data'),

    /**
     * Where that path came from, so startup can say whether state will survive.
     *
     * The project-relative default is correct locally and a trap on a PaaS: it
     * lives inside the container image, so it persists across restarts but is
     * wiped by the next deploy -- long enough to look like it works.
     */
    dataDirSource: str('DATA_DIR')
        ? 'DATA_DIR'
        : str('RAILWAY_VOLUME_MOUNT_PATH')
          ? 'RAILWAY_VOLUME_MOUNT_PATH (attached volume)'
          : 'project default (NOT durable on a PaaS)',

    dataDirIsDurable: Boolean(str('DATA_DIR') || str('RAILWAY_VOLUME_MOUNT_PATH')),

    personaFile: path.join(projectRoot, 'persona.md'),

    /**
     * First-boot bootstrap for hosts with no interactive shell.
     *
     * `npm run auth` prints these. Setting them lets a fresh container adopt an
     * existing authorization instead of needing someone to sit at a terminal.
     * Once the bot has written its own token file, these are ignored.
     */
    bootstrap: {
        botRefreshToken: str('BOT_REFRESH_TOKEN'),
        broadcasterRefreshToken: str('BROADCASTER_REFRESH_TOKEN'),
        moderatorRefreshToken: str('MODERATOR_REFRESH_TOKEN')
    }
};

export const paths = {
    tokens: path.join(config.dataDir, 'tokens.json'),
    budget: path.join(config.dataDir, 'budget.json'),
    notes: path.join(config.dataDir, 'notes.json')
};

/**
 * Collect every configuration problem at once rather than failing on the first.
 * Returns { fatal: string[], warnings: string[] }.
 */
export function validateConfig() {
    const fatal = [];
    const warnings = [];

    if (!config.twitch.clientId) {
        fatal.push('TWITCH_CLIENT_ID is missing — register an app at dev.twitch.tv/console/apps');
    }
    if (!config.twitch.botUsername) fatal.push('BOT_USERNAME is missing');
    if (!config.twitch.channelName) fatal.push('CHANNEL_NAME is missing');

    if (config.twitch.apiToken) {
        warnings.push(
            'Using a static token for Twitch API calls. No refresh and no volume needed, ' +
                'but it cannot be renewed — if Twitch revokes it, re-run `npm run auth`.'
        );
    }

    if (config.twitch.botChatToken) {
        warnings.push(
            'Using a static chat token for the bot account. Chat will post as the bot, ' +
                'while moderation, followage and EventSub run on the broadcaster token. ' +
                'That token cannot refresh — if Twitch revokes it, chat stops.'
        );
    }

    if (!config.ai.apiKey) {
        warnings.push('ANTHROPIC_API_KEY is not set — !chefbot and AI event reactions are disabled');
    }
    // TWITCH_CLIENT_SECRET is intentionally not required. `npm run auth` uses
    // Device Code Flow, which registers a public client, and public clients
    // refresh their tokens without a secret.
    if (config.twitch.authorizedUsers.length === 0) {
        warnings.push('AUTHORIZED_USERS is empty — admin commands are unavailable to everyone');
    }
    if (!config.socials.discord) warnings.push('DISCORD_INVITE is not set — !discord will be unhelpful');
    if (config.ai.dailyUsdCap <= 0) {
        warnings.push('AI_DAILY_USD_CAP is 0 or negative — all AI requests will be refused');
    }

    const validEfforts = ['low', 'medium', 'high'];
    if (!validEfforts.includes(config.ai.effort)) {
        // `between_tools` thinking (our latency setting) is rejected above `high`.
        warnings.push(
            `CLAUDE_EFFORT="${config.ai.effort}" is outside ${validEfforts.join('/')} — ` +
                'higher levels are rejected alongside the low-latency thinking mode. Falling back to "low".'
        );
        config.ai.effort = 'low';
    }

    return { fatal, warnings };
}
