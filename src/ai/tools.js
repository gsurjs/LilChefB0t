import { config } from '../config.js';
import { logger } from '../logger.js';

const noParams = { type: 'object', properties: {}, required: [], additionalProperties: false };

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describeUptime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    if (hours === 0) return plural(mins, 'minute');
    if (mins === 0) return plural(hours, 'hour');
    return `${plural(hours, 'hour')} ${plural(mins, 'minute')}`;
}

/**
 * The tools that turn LilChef from a guesser into something that knows things.
 *
 * Every one of these answers a question chat actually asks ("is he live?", "how
 * long have I followed?", "what's he playing?") that a language model would
 * otherwise confabulate. Schemas are `strict` so the arguments always validate.
 *
 * Tool order is stable on purpose: tools render ahead of the system prompt in
 * the cached prefix, so reordering them would invalidate the cache every boot.
 */
export function buildTools({ twitchApi, memory }) {
    const definitions = [
        {
            name: 'get_stream_status',
            description:
                'Check whether the channel is live right now, and if so what game, title, viewer count and uptime. ' +
                'Use this for any question about whether the stream is up, what is being played, or how long it has been running.',
            input_schema: noParams,
            strict: true
        },
        {
            name: 'get_followage',
            description:
                "Look up how long a viewer has followed the channel. Use the viewer's Twitch username. " +
                'Use this whenever someone asks about their own or another viewer\'s followage.',
            input_schema: {
                type: 'object',
                properties: {
                    username: {
                        type: 'string',
                        description: 'Twitch username, without a leading @.'
                    }
                },
                required: ['username'],
                additionalProperties: false
            },
            strict: true
        },
        {
            name: 'get_recent_clips',
            description:
                'Get the channel\'s most recent clips with titles and links. Use this when someone asks for clips or highlights.',
            input_schema: {
                type: 'object',
                properties: {
                    count: {
                        type: 'integer',
                        // `minimum`/`maximum` are rejected outright by strict
                        // schemas, so the bound lives in the description and is
                        // enforced in the executor. Never trust it from here.
                        description: 'How many clips to return. Must be 1, 2 or 3. Chat is narrow, so prefer 1.'
                    }
                },
                required: ['count'],
                additionalProperties: false
            },
            strict: true
        },
        {
            name: 'get_channel_links',
            description:
                "The channel's Discord, Twitter/X and YouTube links. Use this instead of reciting a link from memory.",
            input_schema: noParams,
            strict: true
        },
        {
            name: 'remember_about_viewer',
            description:
                'Save one short fact the viewer you are currently talking to just told you about themselves ' +
                '(a preference, their platform, a running joke). Only call this when they clearly want to be remembered. ' +
                'Never store anything sensitive, and never store insults or claims about other people.',
            input_schema: {
                type: 'object',
                properties: {
                    note: {
                        type: 'string',
                        description: 'The fact, under 120 characters, written in the third person.'
                    }
                },
                required: ['note'],
                additionalProperties: false
            },
            strict: true
        }
    ];

    /**
     * Executors return plain strings. The model reads them as tool results, and a
     * sentence reads better to it than JSON for this kind of small lookup.
     *
     * `ctx.username` is the person who triggered the request. It is injected by
     * the caller, never taken from tool input -- otherwise a viewer could talk
     * the model into writing notes about somebody else.
     */
    const executors = {
        async get_stream_status() {
            const status = await twitchApi.getStreamStatus();
            if (!status.live) {
                const channel = await twitchApi.getChannelInfo();
                return channel
                    ? `The stream is OFFLINE right now. The channel was last set to "${channel.game}" with the title "${channel.title}".`
                    : 'The stream is OFFLINE right now.';
            }
            return [
                'The stream is LIVE.',
                `Game: ${status.game || 'not set'}.`,
                `Title: ${status.title || 'not set'}.`,
                `Viewers: ${status.viewers}.`,
                `Uptime: ${describeUptime(status.uptimeMinutes)}.`
            ].join(' ');
        },

        async get_followage({ username }) {
            const result = await twitchApi.getFollowage(username);
            if (!result.found) return `There is no Twitch user named "${username}".`;
            if (!result.following) return `${result.displayName} does not follow the channel.`;
            return `${result.displayName} has followed for ${plural(result.days, 'day')}, since ${result.since
                .toISOString()
                .slice(0, 10)}.`;
        },

        async get_recent_clips({ count }) {
            const clips = await twitchApi.getRecentClips(count);
            if (clips.length === 0) return 'The channel has no clips yet.';
            return clips
                .map((clip) => `"${clip.title}" (clipped by ${clip.creator}, ${clip.views} views): ${clip.url}`)
                .join(' | ');
        },

        async get_channel_links() {
            const links = [
                config.socials.discord && `Discord: ${config.socials.discord}`,
                config.socials.twitter && `Twitter/X: ${config.socials.twitter}`,
                config.socials.youtube && `YouTube: ${config.socials.youtube}`
            ].filter(Boolean);
            return links.length > 0 ? links.join(' | ') : 'No social links are configured for this channel.';
        },

        async remember_about_viewer({ note }, ctx) {
            if (!ctx?.username) return 'Could not tell who to remember that about, so nothing was saved.';
            memory.setNote(ctx.username, note);
            logger.info(`Noted about ${ctx.username}: ${note}`);
            return `Saved. You will remember this about ${ctx.username} next time: ${note}`;
        }
    };

    return { definitions, executors };
}
