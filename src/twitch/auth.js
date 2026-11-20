import { RefreshingAuthProvider, StaticAuthProvider } from '@twurple/auth';
import { JsonStore } from '../store.js';
import { logger } from '../logger.js';
import { config, paths } from '../config.js';

/**
 * Scopes the bot account needs.
 *
 * `chat:read` / `chat:edit` cover chat. The moderator scopes are what make
 * !ban, !timeout, !clear and !followage work -- those all go through Helix now,
 * and Helix checks scopes per token rather than per chat badge.
 */
export const BOT_SCOPES = [
    'chat:read',
    'chat:edit',
    'moderator:manage:banned_users',
    'moderator:manage:chat_messages',
    'moderator:read:followers'
];

/**
 * Scopes the broadcaster account needs, and only for EventSub.
 *
 * Twitch requires the broadcaster's own token for sub and cheer notifications;
 * no amount of moderator permission substitutes. Raids and stream online/offline
 * need no scope at all, so skipping this step still leaves those working.
 */
export const BROADCASTER_SCOPES = [
    'channel:read:subscriptions',
    'bits:read',
    'moderator:read:followers',
    'channel:read:redemptions'
];

/**
 * Scopes for a moderator account that is neither the bot nor the broadcaster.
 *
 * This is the "I build bots for someone else's channel" case. Helix checks the
 * scope on the token and that the user moderates the channel -- it does not
 * care which role you consider the account to play. So a moderator's token
 * covers bans, timeouts, message deletion and followage in full.
 *
 * What it cannot cover is anything Twitch authorizes as the broadcaster:
 * stream online/offline via EventSub. Raids, subs and cheers are unaffected
 * because those arrive over chat.
 */
export const MODERATOR_SCOPES = [
    'moderator:manage:banned_users',
    'moderator:manage:chat_messages',
    'moderator:read:followers'
];

/**
 * Ask Twitch what a raw token is, so a bad one fails at startup with a clear
 * reason rather than as an authentication error later.
 *
 * Also the only way to learn a generator token's client ID and scope list,
 * both of which StaticAuthProvider needs to be given correctly.
 */
async function describeToken(raw, label) {
    const token = raw.replace(/^oauth:/, '');

    let response;
    try {
        response = await fetch('https://id.twitch.tv/oauth2/validate', {
            headers: { Authorization: `OAuth ${token}` }
        });
    } catch (err) {
        throw new Error(`Could not reach Twitch to validate the ${label}: ${err.message}`);
    }

    if (!response.ok) {
        throw new Error(
            `Twitch rejected the ${label} (HTTP ${response.status}). It has been revoked or is ` +
                'malformed. Run `npm run auth` to mint a new one.'
        );
    }

    const info = await response.json();
    return {
        token,
        clientId: info.client_id,
        userId: info.user_id,
        login: info.login,
        scopes: info.scopes ?? [],
        // expires_in of 0 means Twitch issued a non-expiring token.
        neverExpires: info.expires_in === 0,
        expiresIn: info.expires_in,
        // A date is actionable; a seconds count is not.
        expiresAt: info.expires_in ? new Date(Date.now() + info.expires_in * 1000) : null
    };
}

/** Keys Twurple's AccessToken actually carries; everything else is ours. */
const tokenOf = (stored) => ({
    accessToken: stored.accessToken,
    refreshToken: stored.refreshToken,
    scope: stored.scope ?? [],
    expiresIn: stored.expiresIn ?? 0,
    obtainmentTimestamp: stored.obtainmentTimestamp ?? 0
});

export class TokenVault {
    #store;

    constructor(file = paths.tokens) {
        this.#store = new JsonStore(file, { users: {} });
    }

    async load() {
        await this.#store.load();
        this.#store.data.users ??= {};
        return this;
    }

    get users() {
        return this.#store.data.users;
    }

    get isEmpty() {
        return Object.keys(this.#store.data.users).length === 0;
    }

    /** Persist a token, preserving the intents and login we recorded alongside it. */
    save(userId, token, { intents, login, role } = {}) {
        const existing = this.#store.data.users[userId] ?? {};
        this.#store.data.users[userId] = {
            ...tokenOf(token),
            intents: intents ?? existing.intents ?? [],
            login: login ?? existing.login,
            role: role ?? existing.role
        };
        this.#store.touch();
    }

    /** Write immediately, bypassing the debounce. Used right after bootstrapping. */
    async flush() {
        await this.#store.flush();
    }

    async close() {
        await this.#store.close();
    }
}

/**
 * Adopt an existing authorization from env vars on a host with no shell.
 *
 * Twurple can derive the user and scopes from a refresh token alone, so a bare
 * BOT_REFRESH_TOKEN is enough to get going. The result is written to the token
 * file immediately, and from then on the file is authoritative -- which matters,
 * because the env var holds a single-use token that is spent on first refresh.
 */
async function bootstrapFromEnv(provider, vault) {
    const seeds = [
        { role: 'bot', token: config.bootstrap.botRefreshToken },
        { role: 'broadcaster', token: config.bootstrap.broadcasterRefreshToken },
        { role: 'moderator', token: config.bootstrap.moderatorRefreshToken }
    ].filter((seed) => seed.token);

    if (seeds.length === 0) return;

    // The chat intent goes to the bot when both accounts are seeded. With only
    // one, that account carries it, so chat still has somewhere to fall back to
    // if a static chat token is later removed.
    for (const seed of seeds) {
        seed.intents = seeds.length === 1 || seed.role === 'bot' ? ['chat'] : [];
    }

    logger.info(`No token file yet — bootstrapping from ${seeds.map((s) => s.role).join(' and ')} refresh token(s)`);
    logger.info(`Token store: ${paths.tokens}  [${config.dataDirSource}]`);

    if (!config.dataDirIsDurable) {
        logger.warn(
            'That path is inside the container, so the rotated token will be LOST on the next ' +
                'deploy and this seed cannot be reused — Twitch invalidates it the moment it is ' +
                'redeemed. Attach a persistent volume (Railway sets RAILWAY_VOLUME_MOUNT_PATH ' +
                'automatically) or set DATA_DIR, before relying on this.'
        );
    }

    for (const seed of seeds) {
        try {
            const userId = await provider.addUserForToken({ refreshToken: seed.token }, seed.intents);
            const token = await provider.getAccessTokenForUser(userId);
            vault.save(userId, token ?? { refreshToken: seed.token }, {
                intents: seed.intents,
                role: seed.role
            });
            logger.info(`Bootstrapped the ${seed.role} account (${userId})`);
        } catch (err) {
            const spent = /invalid refresh token/i.test(err.message);
            logger.error(`Could not bootstrap the ${seed.role} account: ${err.message}`);

            if (spent && !config.dataDirIsDurable) {
                // The usual cause: it worked once, rotated, then the container
                // was replaced and took the replacement with it.
                logger.error(
                    'This seed was already redeemed, and the replacement was written to a ' +
                        'non-durable path, so it is gone. Fix in this order, or it will happen again:\n' +
                        '    1. Attach a persistent volume to the service (or set DATA_DIR)\n' +
                        '    2. Run `npm run auth` again for a fresh token\n' +
                        `    3. Update ${seed.role.toUpperCase()}_REFRESH_TOKEN with the new value`
                );
            } else if (spent) {
                logger.error(
                    'This seed was already redeemed. Run `npm run auth` again and update ' +
                        `${seed.role.toUpperCase()}_REFRESH_TOKEN. The store at ${paths.tokens} is durable, ` +
                        'so this should only be needed once.'
                );
            }
        }
    }

    // Persist now; a crash before the first debounced flush would otherwise
    // leave the spent env-var token as the only credential.
    await vault.flush();
}

/**
 * Build the refreshing auth provider and load every stored user into it.
 *
 * This provider backs Helix and EventSub. Twurple refreshes tokens in the
 * background and each replacement is written straight back to disk, which
 * matters because device-code refresh tokens are single-use.
 */
/**
 * Back Helix with a static token instead of a refreshing one.
 *
 * Returns the same shape as createAuthProvider so the caller does not care
 * which it got. There is no vault because there is nothing to persist: the
 * token does not rotate, which is the entire point.
 */
async function createStaticApiProvider() {
    const info = await describeToken(config.twitch.apiToken, 'static API token (TWITCH_API_TOKEN)');

    const days = info.neverExpires ? null : Math.floor(info.expiresIn / 86_400);
    const lifetime = info.neverExpires
        ? 'does not expire'
        : `expires ${info.expiresAt.toISOString().slice(0, 10)} (${days} days)`;
    logger.info(
        `Twitch API calls run as ${info.login} via a static token (${lifetime}, scopes: ` +
            `${info.scopes.join(', ') || 'none'})`
    );

    // A static token cannot renew itself, so expiry is a diary entry, not an
    // error to recover from. Say so while there is still time to act.
    if (days !== null && days <= 7) {
        logger.warn(
            `TWITCH_API_TOKEN expires in ${days} day(s) and cannot renew itself. ` +
                'Run `npm run auth` and replace it, or the bot stops then.'
        );
    }

    const missing = MODERATOR_SCOPES.filter((scope) => !info.scopes.includes(scope));
    if (missing.length > 0) {
        logger.warn(
            `Static API token is missing ${missing.join(', ')} — the features needing those ` +
                'will report the missing permission when used.'
        );
    }

    return {
        provider: new StaticAuthProvider(info.clientId, info.token, info.scopes),
        // An empty vault purely so the caller's close() works uniformly.
        vault: await new TokenVault().load(),
        knownUserIds: [info.userId]
    };
}

export async function createAuthProvider() {
    // A static token takes precedence: it is the simpler mechanism, and mixing
    // the two would leave it ambiguous which account authorizes a given call.
    if (config.twitch.apiToken) return createStaticApiProvider();

    const vault = await new TokenVault().load();

    const provider = new RefreshingAuthProvider({
        clientId: config.twitch.clientId,
        // Undefined for a public (Device Code Flow) app, which refreshes without
        // a secret. Passing an empty string would break the refresh request.
        clientSecret: config.twitch.clientSecret || undefined
    });

    if (vault.isEmpty) await bootstrapFromEnv(provider, vault);

    if (vault.isEmpty) {
        // Which account is missing depends on the mode, so say the right one.
        const lines = [`No Twitch tokens found at ${paths.tokens}.`];

        if (config.twitch.botChatToken) {
            lines.push(
                '  The bot account is already covered by its static chat token, so one more',
                `  account is needed for the Twitch API: either ${config.twitch.channelName}`,
                '  (the broadcaster) or your own account as a moderator of the channel.',
                '  Run `npm run auth` and it will ask which you can sign in as.',
                '  On a host with no interactive shell, set BROADCASTER_REFRESH_TOKEN or',
                '  MODERATOR_REFRESH_TOKEN to the value that `npm run auth` prints.'
            );
        } else {
            lines.push(
                '  Run `npm run auth` once to authorize the bot account (and optionally the broadcaster).',
                '  On a host with no interactive shell, set BOT_REFRESH_TOKEN to the value',
                '  that `npm run auth` prints.'
            );
        }

        throw new Error(lines.join('\n'));
    }

    provider.onRefresh((userId, token) => {
        vault.save(userId, token);
        logger.debug(`Refreshed token for user ${userId}`);
    });

    provider.onRefreshFailure((userId, error) => {
        const who = vault.users[userId]?.login ?? userId;
        logger.error(
            `Could not refresh the token for ${who}: ${error.message}. ` +
                'Re-run `npm run auth` to re-authorize that account.'
        );
    });

    const loaded = [];
    for (const [userId, stored] of Object.entries(vault.users)) {
        if (!stored.refreshToken) {
            logger.warn(`Stored token for ${stored.login ?? userId} has no refresh token — skipping it`);
            continue;
        }
        provider.addUser(userId, tokenOf(stored), stored.intents ?? []);
        loaded.push(`${stored.login ?? userId}${stored.role ? ` (${stored.role})` : ''}`);
    }

    if (loaded.length === 0) {
        throw new Error('No usable Twitch tokens (none had a refresh token). Run `npm run auth` again.');
    }

    logger.info(`Loaded Twitch tokens for: ${loaded.join(', ')}`);
    return { provider, vault, knownUserIds: Object.keys(vault.users) };
}

/**
 * The auth provider the chat connection uses.
 *
 * Normally this is just the refreshing provider. But when a static bot chat
 * token is configured, chat gets its own provider built from that token, so the
 * bot keeps posting under its own name even though every API call runs on the
 * broadcaster's credentials.
 *
 * The token is validated against Twitch first. A generator token carries a
 * third-party client ID and an opaque scope list, and `StaticAuthProvider`
 * needs both to be right, so reading them off `/oauth2/validate` beats guessing
 * — and it turns a revoked token into a clear startup error instead of a
 * confusing authentication failure later.
 */
export async function createChatAuthProvider(refreshingProvider) {
    if (!config.twitch.botChatToken) return refreshingProvider;

    const info = await describeToken(config.twitch.botChatToken, 'static chat token');

    const required = ['chat:read', 'chat:edit'];
    const missing = required.filter((scope) => !info.scopes.includes(scope));
    if (missing.length > 0) {
        throw new Error(
            `The static chat token is missing ${missing.join(' and ')}, so the bot cannot speak. ` +
                'Authorize the bot account with `npm run auth` instead.'
        );
    }

    if (info.login?.toLowerCase() !== config.twitch.botUsername) {
        logger.warn(
            `The static chat token belongs to "${info.login}", but BOT_USERNAME is ` +
                `"${config.twitch.botUsername}". Chat will post as "${info.login}".`
        );
    }

    const lifetime = info.neverExpires
        ? 'does not expire'
        : `expires ${info.expiresAt.toISOString().slice(0, 10)}`;
    logger.info(
        `Chat will post as ${info.login} via a static token (${lifetime}, scopes: ${info.scopes.join(', ')})`
    );

    return new StaticAuthProvider(info.clientId, info.token, info.scopes);
}
