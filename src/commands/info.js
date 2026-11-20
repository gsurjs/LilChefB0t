import { LEVEL } from './registry.js';
import { config } from '../config.js';
import { cleanUsername, humanDuration, plural } from '../util.js';

export function infoCommands() {
    return [
        {
            name: '!commands',
            aliases: ['!help'],
            help: 'List commands, or explain one.',
            usage: '!commands [command]',
            globalCooldown: 10_000,
            handler: ({ args, user, bot }) => {
                // Generated from the registry, so this can never drift again.
                if (args.length === 0) {
                    return `Available commands: ${bot.registry.publicNames().join(', ')}`;
                }

                const token = args[0].startsWith('!') ? args[0] : `!${args[0]}`;
                const command = bot.registry.resolve(token);
                if (!command) return `@${user.displayName}, there is no ${token} command.`;

                const scope =
                    command.level === LEVEL.ADMIN ? ' (admin only)' : command.level === LEVEL.MOD ? ' (mods only)' : '';
                const usage = command.usage ? ` Usage: ${command.usage}` : '';
                return `${command.name}${scope} — ${command.help ?? 'No description.'}${usage}`;
            }
        },
        {
            name: '!uptime',
            help: 'How long the stream has been live.',
            globalCooldown: 15_000,
            handler: async ({ bot }) => {
                const status = await bot.api.getStreamStatus();
                if (!status.live) return `${config.twitch.channelName} is not live right now. 😴`;
                return `🔴 ${config.twitch.channelName} has been live for ${humanDuration(
                    Date.now() - status.startedAt.getTime()
                )}, playing ${status.game || 'something'} for ${plural(status.viewers, 'viewer')}.`;
            }
        },
        {
            name: '!game',
            aliases: ['!category'],
            help: 'What is being played.',
            globalCooldown: 15_000,
            handler: async ({ bot }) => {
                const status = await bot.api.getStreamStatus();
                if (status.live) return `🎮 Currently playing: ${status.game || 'not set'}`;
                const channel = await bot.api.getChannelInfo();
                return `🎮 Offline. Last category: ${channel?.game || 'unknown'}`;
            }
        },
        {
            name: '!title',
            help: 'The current stream title.',
            globalCooldown: 15_000,
            handler: async ({ bot }) => {
                const status = await bot.api.getStreamStatus();
                if (status.live) return `📺 ${status.title || 'No title set.'}`;
                const channel = await bot.api.getChannelInfo();
                return `📺 Offline. Last title: ${channel?.title || 'unknown'}`;
            }
        },
        {
            name: '!followage',
            help: 'How long you (or someone else) has followed.',
            usage: '!followage [@user]',
            userCooldown: 10_000,
            handler: async ({ user, args, bot }) => {
                const target = args.length > 0 ? cleanUsername(args[0]) : user.userName;
                const result = await bot.api.getFollowage(target);

                if (!result.found) return `@${user.displayName}, there is no Twitch user named "${target}".`;
                if (!result.following) {
                    return target === user.userName
                        ? `@${user.displayName}, you don't follow the channel yet! 👀`
                        : `@${user.displayName}, ${result.displayName} doesn't follow the channel.`;
                }

                const since = result.since.toISOString().slice(0, 10);
                return target === user.userName
                    ? `💜 @${user.displayName}, you've followed for ${plural(result.days, 'day')} (since ${since})!`
                    : `💜 ${result.displayName} has followed for ${plural(result.days, 'day')} (since ${since}).`;
            }
        },
        {
            name: '!so',
            aliases: ['!shoutout'],
            level: LEVEL.MOD,
            help: 'Shout out another streamer, with what they last played.',
            usage: '!so <@user>',
            handler: async ({ user, args, bot }) => {
                if (args.length === 0) return `@${user.displayName}, usage: !so <@user>`;

                const info = await bot.api.getShoutoutInfo(args[0]);
                if (!info) return `@${user.displayName}, there is no Twitch user named "${cleanUsername(args[0])}".`;

                const playing = info.game ? ` They were last seen in ${info.game}.` : '';
                const liveNow = info.live ? ' They are LIVE right now!' : '';
                return `📣 Go show ${info.displayName} some love at https://twitch.tv/${info.name} —${playing}${liveNow}`;
            }
        },
        {
            name: '!clip',
            aliases: ['!clips'],
            help: 'The most recent clip from the channel.',
            globalCooldown: 30_000,
            handler: async ({ bot }) => {
                const clips = await bot.api.getRecentClips(1);
                if (clips.length === 0) return 'No clips on this channel yet. Be the first! ✂️';
                const [clip] = clips;
                return `✂️ "${clip.title}" — clipped by ${clip.creator}: ${clip.url}`;
            }
        },
        {
            name: '!time',
            help: "The streamer's current local time.",
            globalCooldown: 15_000,
            handler: () => `⏰ Current time: ${new Date().toLocaleTimeString()}`
        },
        {
            name: '!botuptime',
            help: 'How long the bot has been running.',
            globalCooldown: 15_000,
            handler: ({ bot }) =>
                `🧑🏻‍🍳 Bot has been awake for ${humanDuration(Date.now() - bot.startedAt)} (v${bot.version}).`
        }
    ];
}
