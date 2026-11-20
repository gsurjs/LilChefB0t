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
