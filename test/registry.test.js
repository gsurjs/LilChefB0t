import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry, LEVEL } from '../src/commands/registry.js';
import { config } from '../src/config.js';

const viewer = { userName: 'viewer', displayName: 'Viewer', isMod: false, isBroadcaster: false };
const mod = { userName: 'themod', displayName: 'TheMod', isMod: true, isBroadcaster: false };
const broadcaster = { userName: 'rogue', displayName: 'Rogue', isMod: false, isBroadcaster: true };
const admin = { userName: 'adminuser', displayName: 'AdminUser', isMod: false, isBroadcaster: false };

/** Collect replies instead of sending them. */
function contextFor(user, text) {
    const sent = [];
    return {
        ctx: { user, text, reply: async (line) => void sent.push(line) },
        sent
    };
}

test.before(() => {
    config.twitch.authorizedUsers = ['adminuser'];
});

test('dispatch ignores non-commands and unknown commands', async () => {
    const registry = new CommandRegistry().register({ name: '!ping', handler: () => 'pong' });

    const plain = contextFor(viewer, 'just chatting');
    assert.equal(await registry.dispatch(plain.ctx), false);

    const unknown = contextFor(viewer, '!nosuchcommand');
    assert.equal(await registry.dispatch(unknown.ctx), false);
    assert.deepEqual(unknown.sent, []);
});

test('aliases resolve to the same command', async () => {
    const registry = new CommandRegistry().register({
        name: '!chefbot',
        aliases: ['!chef', '!ask'],
        handler: () => 'cooking'
    });

    for (const token of ['!chefbot', '!chef', '!ask', '!CHEF']) {
        const { ctx, sent } = contextFor(viewer, token);
        assert.equal(await registry.dispatch(ctx), true, token);
        assert.deepEqual(sent, ['cooking'], token);
    }
});

test('mod commands reject viewers and accept mods, broadcaster and admins', async () => {
    const registry = new CommandRegistry().register({
        name: '!ban',
        level: LEVEL.MOD,
        handler: () => 'banned'
    });

    const denied = contextFor(viewer, '!ban someone');
    assert.equal(await registry.dispatch(denied.ctx), true, 'command was recognised');
    assert.match(denied.sent[0], /moderator privileges required/);

    for (const user of [mod, broadcaster, admin]) {
        const { ctx, sent } = contextFor(user, '!ban someone');
        await registry.dispatch(ctx);
        assert.deepEqual(sent, ['banned'], user.userName);
    }
});

test('admin commands reject mods but accept admins', async () => {
    const registry = new CommandRegistry().register({
        name: '!shutdown',
        level: LEVEL.ADMIN,
        handler: () => 'bye'
    });

    const denied = contextFor(mod, '!shutdown');
    await registry.dispatch(denied.ctx);
    assert.match(denied.sent[0], /admin privileges required/);

    const allowed = contextFor(admin, '!shutdown');
    await registry.dispatch(allowed.ctx);
    assert.deepEqual(allowed.sent, ['bye']);
});

test('per-user cooldown blocks the same user but not a different one', async () => {
    const registry = new CommandRegistry().register({
        name: '!dice',
        userCooldown: 60_000,
        handler: () => 'rolled'
    });

    const first = contextFor(viewer, '!dice');
    await registry.dispatch(first.ctx);
    assert.deepEqual(first.sent, ['rolled']);

    const second = contextFor(viewer, '!dice');
    await registry.dispatch(second.ctx);
    assert.match(second.sent[0], /before you can use !dice again/);

    const other = contextFor({ ...viewer, userName: 'someoneelse' }, '!dice');
    await registry.dispatch(other.ctx);
    assert.deepEqual(other.sent, ['rolled'], 'cooldown is per user');
});

test('global cooldown stays silent so a spammed command cannot become bot spam', async () => {
    const registry = new CommandRegistry().register({
        name: '!socials',
        globalCooldown: 60_000,
        handler: () => 'links'
    });

    const first = contextFor(viewer, '!socials');
    await registry.dispatch(first.ctx);
    assert.deepEqual(first.sent, ['links']);

    const second = contextFor({ ...viewer, userName: 'another' }, '!socials');
    assert.equal(await registry.dispatch(second.ctx), true);
    assert.deepEqual(second.sent, [], 'no response at all during a global cooldown');
});

test('admins bypass cooldowns', async () => {
    const registry = new CommandRegistry().register({
        name: '!fact',
        globalCooldown: 60_000,
        userCooldown: 60_000,
        handler: () => 'fact'
    });

    for (let i = 0; i < 3; i += 1) {
        const { ctx, sent } = contextFor(admin, '!fact');
        await registry.dispatch(ctx);
        assert.deepEqual(sent, ['fact'], `attempt ${i + 1}`);
    }
});

test('a throwing handler is reported, not propagated', async () => {
    const registry = new CommandRegistry().register({
        name: '!boom',
        handler: () => {
            throw new Error('helix exploded');
        }
    });

    const { ctx, sent } = contextFor(viewer, '!boom');
    await assert.doesNotReject(() => registry.dispatch(ctx));
    assert.match(sent[0], /something went wrong with !boom/);
});

test('a handler returning null or an array behaves correctly', async () => {
    const registry = new CommandRegistry()
        .register({ name: '!quiet', handler: () => null })
        .register({ name: '!multi', handler: () => ['one', 'two'] });

    const quiet = contextFor(viewer, '!quiet');
    await registry.dispatch(quiet.ctx);
    assert.deepEqual(quiet.sent, []);

    const multi = contextFor(viewer, '!multi');
    await registry.dispatch(multi.ctx);
    assert.deepEqual(multi.sent, ['one', 'two']);
});

test('the public list excludes mod and admin commands and stays sorted', () => {
    const registry = new CommandRegistry()
        .register({ name: '!zebra', handler: () => null })
        .register({ name: '!apple', handler: () => null })
        .register({ name: '!ban', level: LEVEL.MOD, handler: () => null })
        .register({ name: '!shutdown', level: LEVEL.ADMIN, handler: () => null })
        .register({ name: '!secret', hidden: true, handler: () => null });

    assert.deepEqual(registry.publicNames(), ['!apple', '!zebra']);
    assert.deepEqual(registry.namesAtLevel(LEVEL.MOD), ['!ban']);
    assert.deepEqual(registry.namesAtLevel(LEVEL.ADMIN), ['!shutdown']);
});

test('duplicate names and aliases are rejected at registration', () => {
    const registry = new CommandRegistry().register({ name: '!a', aliases: ['!b'], handler: () => null });

    assert.throws(() => registry.register({ name: '!a', handler: () => null }), /Duplicate command/);
    assert.throws(() => registry.register({ name: '!c', aliases: ['!b'], handler: () => null }), /Duplicate alias/);
    assert.throws(() => registry.register({ name: 'noprefix', handler: () => null }), /must start with/);
});
