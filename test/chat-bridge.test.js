import test from 'node:test';
import assert from 'node:assert/strict';

import { ChatBridge } from '../src/twitch/chat.js';
import { config } from '../src/config.js';

/**
 * Twitch never echoes a message back to the connection that sent it, so a
 * message arriving from our own account proves a second connection exists --
 * another instance of the bot, answering every command in parallel. That is
 * exactly what "two responses in chat" looks like from the inside.
 */
function fakeChatClient() {
    const noop = () => ({ unbind() {} });
    const state = { handler: null, sent: [] };

    return {
        state,
        isConnected: true,
        onMessage: (handler) => {
            state.handler = handler;
            return { unbind() {} };
        },
        say: async (_channel, text) => void state.sent.push(text),
        onConnect: noop,
        onDisconnect: noop,
        onJoin: noop,
        onJoinFailure: noop,
        onAuthenticationFailure: noop,
        onTokenFetchFailure: noop,
        onMessageFailed: noop,
        onMessageRatelimit: noop,
        onNoPermission: noop
    };
}

function bridge() {
    const client = fakeChatClient();
    const b = new ChatBridge({ getAnyAccessToken: async () => ({}) }, { client });
    return { bridge: b, client };
}

const deliver = (client, username, text = '!ai-status') =>
    client.state.handler(`#${config.twitch.channelName}`, username, text, {
        userInfo: { userName: username, displayName: username }
    });

test('messages from viewers reach the handlers', async () => {
    const { bridge: b, client } = bridge();
    const seen = [];
    b.onMessage(({ username, text }) => void seen.push(`${username}:${text}`));

    await deliver(client, 'leg_stiltz');

    assert.deepEqual(seen, ['leg_stiltz:!ai-status']);
    assert.equal(b.sawDuplicateInstance, false);
});

test('a message from our own account flags a duplicate instance', async () => {
    const { bridge: b, client } = bridge();
    const seen = [];
    b.onMessage(({ username }) => void seen.push(username));

    await deliver(client, config.twitch.botUsername, 'some earlier reply');

    assert.equal(b.sawDuplicateInstance, true, 'must detect the second connection');
    assert.deepEqual(seen, [], 'and must not act on our own output');
});

test('the detection is case-insensitive', async () => {
    const { bridge: b, client } = bridge();
    b.onMessage(() => {});

    await deliver(client, config.twitch.botUsername.toUpperCase());
    assert.equal(b.sawDuplicateInstance, true);
});

test('normal traffic after a duplicate is still handled', async () => {
    const { bridge: b, client } = bridge();
    const seen = [];
    b.onMessage(({ username }) => void seen.push(username));

    await deliver(client, config.twitch.botUsername);
    await deliver(client, 'viewer');

    assert.equal(b.sawDuplicateInstance, true);
    assert.deepEqual(seen, ['viewer'], 'the bot keeps working, it just warns');
});

test('a throwing handler does not stop the others', async () => {
    const { bridge: b, client } = bridge();
    const seen = [];
    b.onMessage(() => {
        throw new Error('boom');
    });
    b.onMessage(({ username }) => void seen.push(username));

    await assert.doesNotReject(() => deliver(client, 'viewer'));
    assert.deepEqual(seen, ['viewer']);
});
