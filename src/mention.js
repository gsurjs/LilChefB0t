/**
 * Deciding whether a chat message is talking to the bot.
 *
 * Harder than it looks, because nobody types a bot's name the way it is
 * registered. `lilchefb0t` gets written as "lilchefbot", "LilChef", "chefbot"
 * or "lil chef bot", and a matcher built from the literal username misses all
 * but the first. Two normalisations cover almost everything:
 *
 *  - fold leetspeak digits, so b0t and bot are the same word
 *  - allow separators inside a name, so "lil chef bot" matches "lilchefbot"
 *
 * Deliberately NOT fuzzy beyond that. A bot that butts into conversations it
 * was not part of is worse than one you occasionally have to address twice,
 * so matches are anchored to word boundaries and short generic aliases like
 * "chef" are something you have to opt into.
 */

const LEET = { 0: 'o', 1: 'l', 3: 'e', 4: 'a', 5: 's', 7: 't' };

/** Fold common digit substitutions so b0t, l33t and bot, leet compare equal. */
export const foldLeet = (text) => String(text ?? '').toLowerCase().replace(/[013457]/g, (d) => LEET[d]);

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Build a predicate matching any of `names` as a whole word.
 *
 * @param {string[]} names  Bot name and aliases. Spaces inside a name become
 *   optional separators, so "lil chef" also matches "lilchef" and "lil_chef".
 * @returns {(text: string) => boolean}
 */
export function buildMentionMatcher(names) {
    const SEP = '[\\s_.-]*';

    const terms = [...new Set(names.map((name) => foldLeet(name).replace(/[\s_.-]/g, '').trim()).filter(Boolean))]
        // Longest first so the alternation prefers the most specific match.
        .sort((a, b) => b.length - a.length)
        // A separator may appear between any two characters, so one spelling
        // covers "chefbot", "chef bot", "chef_bot" and "chef-bot".
        .map((term) => [...term].map(escapeRegex).join(SEP));

    if (terms.length === 0) return () => false;

    // Boundaries are "not alphanumeric" rather than \b, so a name ending in a
    // digit still terminates cleanly and `chefbot` does not fire inside a
    // longer word. A leading @ is consumed so "@LilChefB0t" matches too.
    const pattern = new RegExp(`(?:^|[^a-z0-9])@?(?:${terms.join('|')})(?:[^a-z0-9]|$)`, 'i');

    return (text) => pattern.test(foldLeet(text));
}
