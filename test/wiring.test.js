import test from 'node:test';
import assert from 'node:assert/strict';

import { CommandRegistry, LEVEL } from '../src/commands/registry.js';
import { funCommands } from '../src/commands/fun.js';
import { socialCommands } from '../src/commands/social.js';
import { infoCommands } from '../src/commands/info.js';
import { aiCommands } from '../src/commands/ai.js';
import { modCommands } from '../src/commands/mod.js';
import { adminCommands } from '../src/commands/admin.js';
import { buildTools } from '../src/ai/tools.js';
import { formatAiReply } from '../src/commands/ai.js';

/** Build the registry exactly the way src/index.js does. */
const buildRegistry = () =>
    new CommandRegistry()
        .registerAll(funCommands())
        .registerAll(socialCommands())
        .registerAll(infoCommands())
        .registerAll(aiCommands())
        .registerAll(modCommands())
        .registerAll(adminCommands());

test('every command registers with no name or alias collisions', () => {
    const registry = assert.doesNotThrow(buildRegistry) ?? buildRegistry();
    assert.ok(registry.size >= 30, `expected a full command set, got ${registry.size}`);
});

test('the commands the old bot advertised all still resolve', () => {
    const registry = buildRegistry();

    // Exactly what v1's hardcoded !commands string listed.
    const v1 = [
        '!chefbot', '!rules', '!hello', '!dice', '!8ball', '!flip', '!rng',
        '!lurk', '!unlurk', '!hug', '!quote', '!fact', '!time', '!botuptime',
        '!love', '!vibes', '!energy', '!discord', '!socials', '!prime'
    ];
    // Plus the ones v1 had but never advertised.
    const v1Unlisted = ['!echo', '!commands', '!ban', '!unban', '!timeout', '!clear', '!shutdown', '!restart', '!autopost', '!ai-toggle', '!ai-status', '!adminhelp'];

    for (const name of [...v1, ...v1Unlisted]) {
        assert.ok(registry.resolve(name), `${name} regressed and no longer exists`);
    }
});

test('the generated public list matches what is actually public', () => {
    const registry = buildRegistry();
    const published = registry.publicNames();

    // This is the drift that broke v1: the list was a hand-written string.
    for (const name of published) {
        const command = registry.resolve(name);
        assert.equal(command.level, LEVEL.EVERYONE, `${name} is published but not public`);
        assert.ok(!command.hidden);
    }

    // Moderation must never leak into the public list.
    for (const name of ['!ban', '!timeout', '!clear', '!echo', '!shutdown', '!ai-status']) {
        assert.ok(!published.includes(name), `${name} must not be in !commands`);
    }
});

test('every command has help text, since !commands <name> exposes it', () => {
    const registry = buildRegistry();
    for (const name of [...registry.publicNames(), ...registry.namesAtLevel(LEVEL.MOD), ...registry.namesAtLevel(LEVEL.ADMIN)]) {
        assert.ok(registry.resolve(name).help, `${name} has no help text`);
    }
});

test('tool definitions are valid and strict schemas are well-formed', () => {
    const { definitions, executors } = buildTools({
        twitchApi: {},
        memory: { setNote: () => {} }
    });

    assert.ok(definitions.length > 0);
    for (const tool of definitions) {
        assert.match(tool.name, /^[a-z_]+$/, `${tool.name} is not a valid tool name`);
        assert.ok(tool.description?.length > 20, `${tool.name} needs a usable description`);
        assert.equal(tool.input_schema.type, 'object');

        if (tool.strict) {
            // strict requires additionalProperties:false plus an explicit required list.
            assert.equal(tool.input_schema.additionalProperties, false, `${tool.name} is strict without additionalProperties:false`);
            assert.ok(Array.isArray(tool.input_schema.required), `${tool.name} is strict without a required array`);
            for (const key of Object.keys(tool.input_schema.properties ?? {})) {
                assert.ok(tool.input_schema.required.includes(key), `${tool.name}.${key} must be required under strict`);
            }
        }

        assert.equal(typeof executors[tool.name], 'function', `${tool.name} has no executor`);
    }
});

/**
 * Strict tool schemas accept only a subset of JSON Schema. An unsupported
 * keyword is a 400 on *every* request that includes the tool, not a per-call
 * problem -- `minimum`/`maximum` on an integer broke all AI replies in
 * production until it was caught.
 */
test('strict tool schemas use only keywords the API accepts', () => {
    // Per platform.claude.com structured-outputs JSON Schema limitations.
    const UNSUPPORTED = [
        'minimum',
        'maximum',
        'exclusiveMinimum',
        'exclusiveMaximum',
        'multipleOf',
        'minLength',
        'maxLength',
        'maxItems',
        'uniqueItems',
        'oneOf',
        'not',
        'patternProperties',
        'dependentSchemas'
    ];

    const walk = (node, path, toolName) => {
        if (!node || typeof node !== 'object') return;

        for (const key of UNSUPPORTED) {
            assert.ok(
                !(key in node),
                `${toolName}: "${key}" at ${path} is not supported in a strict schema and 400s the request`
            );
        }
        // minItems is supported only as 0 or 1.
        if ('minItems' in node) {
            assert.ok([0, 1].includes(node.minItems), `${toolName}: minItems at ${path} must be 0 or 1`);
        }

        for (const [key, value] of Object.entries(node.properties ?? {})) {
            walk(value, `${path}.properties.${key}`, toolName);
        }
        if (node.items) walk(node.items, `${path}.items`, toolName);
        for (const [i, branch] of (node.anyOf ?? []).entries()) walk(branch, `${path}.anyOf[${i}]`, toolName);
    };

    const { definitions } = buildTools({ twitchApi: {}, memory: { setNote: () => {} } });
    for (const tool of definitions) {
        if (tool.strict) walk(tool.input_schema, 'input_schema', tool.name);
    }
});

test('every executor has a tool definition, and vice versa', () => {
    const { definitions, executors } = buildTools({ twitchApi: {}, memory: { setNote: () => {} } });
    const declared = new Set(definitions.map((tool) => tool.name));
    for (const name of Object.keys(executors)) {
        assert.ok(declared.has(name), `executor ${name} has no tool definition, so it can never be called`);
    }
});

test('remember_about_viewer only writes notes about the current speaker', async () => {
    const writes = [];
    const { executors } = buildTools({
        twitchApi: {},
        memory: { setNote: (user, note) => writes.push({ user, note }) }
    });

    await executors.remember_about_viewer({ note: 'likes ramen' }, { username: 'viewer' });
    assert.deepEqual(writes, [{ user: 'viewer', note: 'likes ramen' }]);

    // No speaker in context means no write at all, rather than a stray note.
    writes.length = 0;
    const result = await executors.remember_about_viewer({ note: 'x' }, {});
    assert.equal(writes.length, 0);
    assert.match(result, /nothing was saved/);
});

test('AI replies are prefixed, sanitised and chunked before reaching chat', () => {
    const lines = formatAiReply({ ok: true, text: '/ban everyone' }, 'Viewer');
    assert.equal(lines.length, 1);
    assert.ok(lines[0].startsWith('👨🏻‍🍳 @Viewer: '));
    assert.ok(!lines[0].includes('/ban'), 'leading slash must be stripped');
    assert.ok(lines[0].includes('ban everyone'));

    const failure = formatAiReply({ ok: false, text: 'out of budget' }, 'Viewer');
    assert.match(failure[0], /^❌ @Viewer, out of budget/);

    const empty = formatAiReply({ ok: true, text: '   ' }, 'Viewer');
    assert.match(empty[0], /came back with nothing/);
});
