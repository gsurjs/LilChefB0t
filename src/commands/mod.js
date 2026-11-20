import { LEVEL } from './registry.js';
import { logger } from '../logger.js';
import { cleanUsername, humanDuration } from '../util.js';

/**
 * Moderation, through the Helix API.
 *
 * The previous version of these commands returned strings like `/ban someone`
 * for the chat client to send. Twitch removed IRC chat-command handling on
 * 18 February 2023, so those have been posting as literal plain text ever
 * since -- visible to chat, doing nothing. Everything here is a real REST call
 * against /helix/moderation/*.
 */

const parseDuration = (raw) => {
    if (!raw) return null;
    const match = /^(\d+)([smhd]?)$/i.exec(raw.trim());
    if (!match) return null;
    const value = Number.parseInt(match[1], 10);
    const unit = (match[2] || 's').toLowerCase();
    const seconds = value * { s: 1, m: 60, h: 3600, d: 86_400 }[unit];
    // Twitch caps a timeout at 14 days.
    return seconds > 0 && seconds <= 1_209_600 ? seconds : null;
};

/** Turn a Helix/auth failure into something a mod can act on. */
const explain = (err, user, action) => {
    if (/holds "/.test(err.message)) {
        logger.error(`${action} blocked: ${err.message}`);
        return `❌ @${user.displayName}, I'm missing the Twitch permission for that. The chef needs to re-run the auth setup.`;
    }
    if (/No Twitch user named/.test(err.message)) {
        return `❌ @${user.displayName}, ${err.message}.`;
    }
    logger.error(`${action} failed:`, err);
    return `❌ @${user.displayName}, Twitch rejected that: ${err.message}`;
};

export function modCommands() {
    return [
        {
            name: '!ban',
            level: LEVEL.MOD,
            help: 'Permanently ban a user.',
            usage: '!ban <@user> [reason]',
            handler: async ({ user, args, bot }) => {
                if (args.length === 0) return `❌ @${user.displayName}, usage: !ban <@user> [reason]`;

                const reason = args.slice(1).join(' ');
                try {
                    const target = await bot.api.banUser(args[0], reason);
                    logger.info(`BAN ${target.name} by ${user.userName}${reason ? ` — ${reason}` : ''}`);
                    return `🔨 ${target.displayName} has been banned${reason ? ` (${reason})` : ''}.`;
                } catch (err) {
                    return explain(err, user, 'ban');
                }
            }
        },
        {
            name: '!unban',
            level: LEVEL.MOD,
            help: 'Lift a ban or timeout.',
            usage: '!unban <@user>',
            handler: async ({ user, args, bot }) => {
                if (args.length === 0) return `❌ @${user.displayName}, usage: !unban <@user>`;

                try {
                    const target = await bot.api.unbanUser(args[0]);
                    logger.info(`UNBAN ${target.name} by ${user.userName}`);
                    return `🔓 ${target.displayName} has been unbanned.`;
                } catch (err) {
                    return explain(err, user, 'unban');
                }
            }
        },
        {
            name: '!timeout',
            aliases: ['!to'],
            level: LEVEL.MOD,
            help: 'Time a user out. Duration accepts 60, 10m, 1h, 1d.',
            usage: '!timeout <@user> [duration] [reason]',
            handler: async ({ user, args, bot }) => {
                if (args.length === 0) return `❌ @${user.displayName}, usage: !timeout <@user> [duration] [reason]`;

                // Duration is optional, so decide whether args[1] is one.
                const parsed = parseDuration(args[1]);
                const seconds = parsed ?? 60;
                const reason = (parsed ? args.slice(2) : args.slice(1)).join(' ');

                if (args[1] && !parsed && /^\d/.test(args[1])) {
                    return `❌ @${user.displayName}, "${args[1]}" is not a valid duration (max 14d).`;
                }

                try {
                    const target = await bot.api.timeoutUser(cleanUsername(args[0]), seconds, reason);
                    logger.info(`TIMEOUT ${target.name} ${seconds}s by ${user.userName}${reason ? ` — ${reason}` : ''}`);
                    return `⏳ ${target.displayName} timed out for ${humanDuration(seconds * 1000)}${
                        reason ? ` (${reason})` : ''
                    }.`;
                } catch (err) {
                    return explain(err, user, 'timeout');
                }
            }
        },
        {
            name: '!echo',
            level: LEVEL.MOD,
            help: 'Make the bot say something.',
            usage: '!echo <message>',
            // Was open to everyone in v1, which made the bot a spam amplifier.
            handler: ({ user, args }) =>
                args.length > 0 ? `📢 ${args.join(' ')}` : `@${user.displayName}, usage: !echo <message>`
        },
        {
            name: '!clear',
            level: LEVEL.MOD,
            help: 'Clear the chat.',
            handler: async ({ user, bot }) => {
                try {
                    await bot.api.clearChat();
                    logger.info(`CHAT CLEARED by ${user.userName}`);
                    return null; // The clear itself is the feedback.
                } catch (err) {
                    return explain(err, user, 'clear chat');
                }
            }
        }
    ];
}
