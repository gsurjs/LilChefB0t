import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry } from '../src/commands/registry.js';
import { modCommands } from '../src/commands/mod.js';

const mod = { userName: 'themod', displayName: 'TheMod', isMod: true, isBroadcaster: false };

/** Registry wired to a fake Helix layer that records calls. */
function harness({ fail } = {}) {
    const calls = [];
    const target = (name) => ({ name: name.replace(/^@/, '').toLowerCase(), displayName: 'Target' });

    const api = {
        banUser: async (user, reason) => {
            if (fail) throw fail;
            calls.push({ op: 'ban', user, reason });
            return target(user);
        },
        unbanUser: async (user) => {
            if (fail) throw fail;
            calls.push({ op: 'unban', user });
            return target(user);
        },
        timeoutUser: async (user, seconds, reason) => {
            if (fail) throw fail;
            calls.push({ op: 'timeout', user, seconds, reason });
            return target(user);
        },
        clearChat: async () => {
            if (fail) throw fail;
            calls.push({ op: 'clear' });
        }
    };

    const registry = new CommandRegistry().registerAll(modCommands());

    const run = async (text) => {
        const sent = [];
        await registry.dispatch({
            user: mod,
            text,
            bot: { api },
            reply: async (line) => void sent.push(line)
        });
        return sent;
    };

    return { run, calls };
}

test('!ban calls Helix and reports the ban', async () => {
    const { run, calls } = harness();
    const sent = await run('!ban @Spammer being rude');

    assert.deepEqual(calls, [{ op: 'ban', user: '@Spammer', reason: 'being rude' }]);
    assert.match(sent[0], /banned \(being rude\)/);
});

test('!ban with no reason still works', async () => {
    const { run, calls } = harness();
    await run('!ban spammer');
    assert.equal(calls[0].reason, '');
});

test('!ban without a target explains the usage instead of calling Helix', async () => {
    const { run, calls } = harness();
    const sent = await run('!ban');

    assert.deepEqual(calls, [], 'no API call on a malformed command');
    assert.match(sent[0], /usage: !ban/);
});

test('!timeout parses every documented duration form', async () => {
    const cases = [
        ['!timeout user 60', 60],
        ['!timeout user 30s', 30],
        ['!timeout user 10m', 600],
        ['!timeout user 1h', 3600],
        ['!timeout user 1d', 86_400],
        ['!timeout user 14d', 1_209_600]
    ];

    for (const [text, expected] of cases) {
        const { run, calls } = harness();
        await run(text);
        assert.equal(calls[0]?.seconds, expected, text);
    }
});

test('!timeout defaults to 60 seconds when no duration is given', async () => {
    const { run, calls } = harness();
    await run('!timeout user');
    assert.equal(calls[0].seconds, 60);
    assert.equal(calls[0].reason, '');
});

test('a non-duration second word is treated as the reason, not a duration', async () => {
    const { run, calls } = harness();
    await run('!timeout user spamming links');

    assert.equal(calls[0].seconds, 60);
    assert.equal(calls[0].reason, 'spamming links', 'the reason must not be eaten by duration parsing');
});

test('a duration plus a reason splits correctly', async () => {
    const { run, calls } = harness();
    await run('!timeout user 10m posting spoilers');

    assert.equal(calls[0].seconds, 600);
    assert.equal(calls[0].reason, 'posting spoilers');
});

test('a numeric duration over the Twitch maximum is rejected', async () => {
    const { run, calls } = harness();
    const sent = await run('!timeout user 30d');

    assert.deepEqual(calls, [], 'must not call Helix with an invalid duration');
    assert.match(sent[0], /not a valid duration/);
});

test('!clear sends no confirmation, because the clear is the feedback', async () => {
    const { run, calls } = harness();
    const sent = await run('!clear');

    assert.deepEqual(calls, [{ op: 'clear' }]);
    assert.deepEqual(sent, []);
});

test('a missing scope produces an actionable message, not a stack trace', async () => {
    const { run } = harness({
        fail: new Error('No authorized token holds "moderator:manage:banned_users". Re-run `npm run auth`.')
    });
    const sent = await run('!ban someone');

    assert.match(sent[0], /missing the Twitch permission/);
    assert.match(sent[0], /re-run the auth setup/i);
});

test('an unknown target is reported plainly', async () => {
    const { run } = harness({ fail: new Error('No Twitch user named "ghost"') });
    const sent = await run('!unban ghost');
    assert.match(sent[0], /No Twitch user named "ghost"/);
});

test('an unexpected Helix failure surfaces the reason', async () => {
    const { run } = harness({ fail: new Error('HTTP 503 Service Unavailable') });
    const sent = await run('!ban someone');
    assert.match(sent[0], /Twitch rejected that: HTTP 503/);
});

test('!echo requires an argument and is mod-gated', async () => {
    const { run } = harness();
    assert.match((await run('!echo'))[0], /usage: !echo/);
    assert.equal((await run('!echo hello chat'))[0], '📢 hello chat');

    // A plain viewer must be refused.
    const registry = new CommandRegistry().registerAll(modCommands());
    const sent = [];
    await registry.dispatch({
        user: { userName: 'viewer', displayName: 'Viewer', isMod: false, isBroadcaster: false },
        text: '!echo spam',
        bot: { api: {} },
        reply: async (line) => void sent.push(line)
    });
    assert.match(sent[0], /moderator privileges required/);
});
