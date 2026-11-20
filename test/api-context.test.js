import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshingAuthProvider } from '@twurple/auth';

import { TwitchApi } from '../src/twitch/api.js';

/**
 * Every Helix call must run inside a user context.
 *
 * Twurple sends any call made outside one with an *app* access token, and
 * minting an app token requires a client secret. A Public Twitch app has no
 * secret, so an unguarded call fails at runtime with "App access tokens require
 * you to pass a clientSecret" -- which is what took the first deploy down, on
 * a plain username lookup that needs no scope at all.
 *
 * The fake client below makes that failure mode a test failure instead: its
 * direct namespaces throw, and only the context handed to asUser works.
 */
function fakeApiClient() {
    const unguarded = (name) => () => {
        throw new Error(`UNGUARDED Helix call: ${name} ran outside asUser and would use an app token`);
    };

    const ctx = {
        users: {
            getUserByName: async (name) => ({ id: `id-${name}`, name, displayName: name })
        },
        streams: { getStreamByUserId: async () => null },
        channels: {
            getChannelInfoById: async () => ({ gameName: 'Hades II', title: 'cooking', tags: [], language: 'en' }),
            getChannelFollowers: async () => ({ data: [] })
        },
        clips: { getClipsForBroadcaster: async () => ({ data: [] }) },
        moderation: {
            banUser: async () => [],
            unbanUser: async () => undefined,
            deleteChatMessages: async () => undefined
        }
    };

    const contexts = [];
    return {
        contexts,
        asUser: async (userId, runner) => {
            contexts.push(userId);
            return runner(ctx);
        },
        // Anything reached directly is a bug.
        users: { getUserByName: unguarded('users.getUserByName') },
        streams: { getStreamByUserId: unguarded('streams.getStreamByUserId') },
        channels: { getChannelInfoById: unguarded('channels.getChannelInfoById') },
        clips: { getClipsForBroadcaster: unguarded('clips.getClipsForBroadcaster') },
        moderation: { banUser: unguarded('moderation.banUser') }
    };
}

const MOD_ID = '786550584';

/** A provider holding only a moderator token -- the real deployed shape. */
function moderatorOnlyApi() {
    const provider = new RefreshingAuthProvider({ clientId: 'test-client' });
    provider.addUser(
        MOD_ID,
        {
            accessToken: 'at',
            refreshToken: 'rt',
            scope: ['moderator:manage:banned_users', 'moderator:manage:chat_messages', 'moderator:read:followers'],
            expiresIn: 3600,
            obtainmentTimestamp: Date.now()
        },
        []
    );
    const apiClient = fakeApiClient();
    const api = new TwitchApi(provider, { knownUserIds: [MOD_ID], apiClient });
    return { api, apiClient };
}

test('init() resolves usernames under a user token, not an app token', async () => {
    const { api, apiClient } = moderatorOnlyApi();

    // Before the fix this threw "App access tokens require ... clientSecret".
    await api.init();

    assert.ok(apiClient.contexts.length > 0, 'init must use asUser');
    assert.ok(
        apiClient.contexts.every((id) => id === MOD_ID),
        'the only authorized account must be the context user'
    );
});

test('every read path runs inside a user context', async () => {
    const { api } = moderatorOnlyApi();
    await api.init();

    // Each of these would throw "UNGUARDED Helix call" if it bypassed asUser.
    await assert.doesNotReject(() => api.getStreamStatus(), 'getStreamStatus');
    await assert.doesNotReject(() => api.getChannelInfo(), 'getChannelInfo');
    await assert.doesNotReject(() => api.getFollowage('someone'), 'getFollowage');
    await assert.doesNotReject(() => api.getRecentClips(1), 'getRecentClips');
    await assert.doesNotReject(() => api.getShoutoutInfo('someone'), 'getShoutoutInfo');
});

test('moderation runs inside a user context on the scope holder', async () => {
    const { api, apiClient } = moderatorOnlyApi();
    await api.init();
    apiClient.contexts.length = 0;

    await api.banUser('spammer', 'testing');
    await api.timeoutUser('spammer', 60, 'testing');
    await api.unbanUser('spammer');
    await api.clearChat();

    assert.ok(apiClient.contexts.length >= 4, 'each moderation call sets a user context');
    assert.ok(
        apiClient.contexts.every((id) => id === MOD_ID),
        'moderation must run as the account holding the scope'
    );
});

test('contextUserId prefers the bot, then broadcaster, then any known account', async () => {
    const { api } = moderatorOnlyApi();
    // Only the moderator is authorized, so it must be chosen even though
    // init() resolves bot and broadcaster IDs that have no tokens.
    await api.init();
    assert.equal(api.contextUserId, MOD_ID);
});

test('with no authorized user at all, the error names the fix', async () => {
    const provider = new RefreshingAuthProvider({ clientId: 'test-client' });
    const api = new TwitchApi(provider, { knownUserIds: [], apiClient: fakeApiClient() });

    assert.equal(api.contextUserId, null);
    await assert.rejects(() => api.init(), /npm run auth|REFRESH_TOKEN/);
});

/**
 * A StaticAuthProvider has no hasUser(), because it serves exactly one user.
 * knows() must handle that, or contextUserId returns null and every Helix call
 * fails with "no user token available" despite a perfectly good token.
 */
test('knows() works for a provider that serves a single static user', () => {
    const staticish = {
        // No hasUser, like StaticAuthProvider.
        getCurrentScopesForUser: () => ['moderator:manage:banned_users']
    };
    const api = new TwitchApi(staticish, { knownUserIds: ['999'], apiClient: fakeApiClient() });

    assert.equal(api.knows('999'), true, 'the user we were handed must be known');
    assert.equal(api.knows('other'), false);
    assert.equal(api.contextUserId, '999', 'and must be usable as the call context');
    assert.equal(api.findHolder('moderator:manage:banned_users'), '999');
});

test('a static provider still routes reads through a user context', async () => {
    const staticish = { getCurrentScopesForUser: () => ['moderator:read:followers'] };
    const apiClient = fakeApiClient();
    const api = new TwitchApi(staticish, { knownUserIds: ['999'], apiClient });

    await api.init();
    assert.ok(apiClient.contexts.length > 0);
    assert.ok(apiClient.contexts.every((id) => id === '999'));
});

/**
 * StaticAuthProvider.getCurrentScopesForUser() ignores its argument and reports
 * the single token's scopes for any user you ask about. Scope lookups must be
 * gated on actual ownership, or findHolder names an account that does not hold
 * the scope -- which produced a 403 on an EventSub subscription authorized as
 * the bot account instead of the moderator.
 */
test('a static provider never claims scopes for an account it does not serve', () => {
    const MOD = '786550584';
    const BOT = '1326537281';
    const staticish = {
        // Mirrors Twurple: the userId argument is ignored.
        getCurrentScopesForUser: () => ['moderator:read:followers', 'moderator:manage:banned_users']
    };
    const api = new TwitchApi(staticish, { knownUserIds: [MOD], apiClient: fakeApiClient() });

    assert.deepEqual(api.scopesFor(BOT), [], 'must not report another account as holding the scope');
    assert.equal(api.hasScope(BOT, 'moderator:read:followers'), false);

    assert.ok(api.scopesFor(MOD).includes('moderator:read:followers'), 'the real holder still reports it');
    assert.equal(api.findHolder('moderator:read:followers'), MOD, 'findHolder must name the actual holder');
});

test('findHolder prefers the bot only when the bot genuinely holds the scope', () => {
    const BOT = '100';
    const MOD = '200';
    const provider = new RefreshingAuthProvider({ clientId: 'test-client' });
    // Bot token has chat scopes only; the moderator holds the real one.
    for (const [id, scope] of [
        [BOT, ['chat:read', 'chat:edit']],
        [MOD, ['moderator:read:followers']]
    ]) {
        provider.addUser(
            id,
            { accessToken: 'at', refreshToken: 'rt', scope, expiresIn: 3600, obtainmentTimestamp: Date.now() },
            []
        );
    }

    const api = new TwitchApi(provider, { knownUserIds: [BOT, MOD], apiClient: fakeApiClient() });
    assert.equal(api.findHolder('moderator:read:followers'), MOD);
    assert.equal(api.findHolder('chat:edit'), BOT);
});
