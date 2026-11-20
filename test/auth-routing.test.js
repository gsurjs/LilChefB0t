import test from 'node:test';
import assert from 'node:assert/strict';
import { RefreshingAuthProvider } from '@twurple/auth';

import { TwitchApi } from '../src/twitch/api.js';
import { createChatAuthProvider } from '../src/twitch/auth.js';
import { config } from '../src/config.js';

/**
 * These cover the split-identity setup: chat runs on a static token for the bot
 * account, while Helix and EventSub run on the broadcaster's refreshing token.
 *
 * The load-bearing detail is that asking a RefreshingAuthProvider about a user
 * it has never been given *throws*. If that ever started returning undefined
 * instead, `hasScope` would blow up and moderation would fail with a confusing
 * error rather than falling through to the broadcaster.
 */

test('scope lookup for an unknown user yields [] rather than throwing', () => {
    const provider = new RefreshingAuthProvider({ clientId: 'test-client' });
    const api = new TwitchApi(provider);

    // Directly confirm the underlying behaviour this depends on.
    assert.throws(() => provider.getCurrentScopesForUser('999'), 'Twurple should reject unknown users');

    assert.deepEqual(api.scopesFor('999'), [], 'must be an empty array, not undefined');
    assert.equal(api.hasScope('999', 'moderator:manage:banned_users'), false);
});

test('scope lookup reflects a user the provider does know', () => {
    const provider = new RefreshingAuthProvider({ clientId: 'test-client' });
    provider.addUser(
        '12345',
        {
            accessToken: 'at',
            refreshToken: 'rt',
            scope: ['moderator:manage:banned_users', 'bits:read'],
            expiresIn: 3600,
            obtainmentTimestamp: Date.now()
        },
        ['chat']
    );

    const api = new TwitchApi(provider);
    assert.deepEqual(api.scopesFor('12345').sort(), ['bits:read', 'moderator:manage:banned_users']);
    assert.equal(api.hasScope('12345', 'moderator:manage:banned_users'), true);
    assert.equal(api.hasScope('12345', 'channel:read:subscriptions'), false);
});

test('with no static token, chat reuses the refreshing provider', async () => {
    const previous = config.twitch.botChatToken;
    config.twitch.botChatToken = '';
    try {
        const sentinel = { iAm: 'the refreshing provider' };
        assert.equal(await createChatAuthProvider(sentinel), sentinel);
    } finally {
        config.twitch.botChatToken = previous;
    }
});

test('a malformed static token fails startup with an actionable message', async () => {
    const previous = config.twitch.botChatToken;
    // Shaped like a token but not one Twitch will accept.
    config.twitch.botChatToken = 'oauth:definitely_not_a_real_token_value';
    try {
        await assert.rejects(() => createChatAuthProvider({}), (err) => {
            assert.match(err.message, /revoked|malformed|reach Twitch/i);
            // The message has to tell the operator what to actually do.
            assert.match(err.message, /npm run auth|BOT_CHAT_TOKEN|broadcaster/i);
            return true;
        });
    } finally {
        config.twitch.botChatToken = previous;
    }
});
