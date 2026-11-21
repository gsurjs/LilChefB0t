import test from 'node:test';
import assert from 'node:assert/strict';

import { buildMentionMatcher, foldLeet } from '../src/mention.js';

// The real deployed configuration.
const matches = buildMentionMatcher(['lilchefb0t', 'chefbot', 'lilchef']);

test('leet folding normalises digit substitutions', () => {
    assert.equal(foldLeet('LilChefB0t'), 'lilchefbot');
    assert.equal(foldLeet('L33T'), 'leet');
    assert.equal(foldLeet(null), '');
});

/**
 * Every one of these was reported or observed in real chat. "lilchefbot" and
 * "chefbot" both silently failed before: the username carries a zero, and the
 * old fallback pattern required a word boundary immediately after "chef",
 * which the trailing "bot" removed.
 */
test('the spellings people actually type all match', () => {
    for (const text of [
        'LilChef you here my guy?',
        'lilchefbot you up?',
        'LilChefBot hello',
        'chefbot whats good',
        '@lilchefb0t hey',
        '@LilChefB0t hey',
        'lil chef bot hey',
        'hey chef bot',
        'lilchef hello',
        'yo @ChefBot!',
        'chef_bot you there',
        'chef-bot help',
        'LIL CHEF what is the uptime',
        'so lilchefbot, what do you think'
    ]) {
        assert.ok(matches(text), `should have matched: ${text}`);
    }
});

/**
 * Over-triggering is worse than under-triggering: a bot that interrupts
 * conversations it was not part of is more annoying than one you address
 * twice. "chef" alone is deliberately not a trigger in a cooking channel.
 */
test('ordinary chat does not trigger a reply', () => {
    for (const text of [
        'the chef is cooking',
        'chef',
        'that chef is nice',
        'chefs kiss',
        'what a mischief',
        'chefbotanical gardens',
        'beef bot',
        'I love this stream',
        'robot vacuum',
        ''
    ]) {
        assert.ok(!matches(text), `should NOT have matched: ${text}`);
    }
});

test('a name is matched at the start, middle and end of a message', () => {
    assert.ok(matches('chefbot hello'));
    assert.ok(matches('hey chefbot how are you'));
    assert.ok(matches('what do you think chefbot'));
    assert.ok(matches('chefbot'));
});

test('an empty or missing alias list never matches', () => {
    const never = buildMentionMatcher([]);
    assert.equal(never('chefbot'), false);

    const blanks = buildMentionMatcher(['', '   ']);
    assert.equal(blanks('anything'), false);
});

test('aliases are configurable and regex-special characters are escaped', () => {
    const custom = buildMentionMatcher(['c.h.e.f', 'bot+']);
    assert.ok(custom('hey chef there'), 'dots are treated as separators, not wildcards');
    assert.ok(!custom('cXhXeXf'), 'a dot must not behave as "any character"');
    assert.ok(custom('bot+ hello'));
});

/**
 * Commands are dispatched before the mention path, so a match here is
 * harmless -- but if that ordering ever changed, "!chefbot x" would be
 * answered twice. Pinning the expectation documents the dependency.
 */
test('a command form still matches, which is safe only because dispatch runs first', () => {
    assert.ok(matches('!chefbot hello'), 'matcher is not command-aware by design');
});
