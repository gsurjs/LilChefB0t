import { LEVEL } from './registry.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { humanDuration } from '../util.js';

export function adminCommands() {
    return [
        {
            name: '!ai-toggle',
            level: LEVEL.ADMIN,
            help: 'Turn the AI commands on or off.',
            handler: ({ user, bot }) => {
                bot.state.aiEnabled = !bot.state.aiEnabled;
                logger.info(`AI ${bot.state.aiEnabled ? 'enabled' : 'disabled'} by ${user.userName}`);
                return bot.state.aiEnabled
                    ? '👨🏻‍🍳 Chef AI enabled! Chatters can use !chefbot <question>.'
                    : '👨🏻‍🍳 Chef AI disabled. No longer cooking.';
            }
        },
        {
            name: '!ai-status',
            level: LEVEL.ADMIN,
            help: 'Model, spend and cache diagnostics.',
            handler: ({ bot }) => {
                const spend = bot.ledger.summary;
                const key = config.ai.apiKey ? '✅ key set' : '❌ no key';
                const cache = `${Math.round(spend.cacheHitRate * 100)}% cached`;
                return (
                    `👨🏻‍🍳 AI: ${bot.state.aiEnabled ? 'on' : 'off'} | ${config.ai.model} @ effort=${config.ai.effort} | ` +
                    `${key} | today: $${spend.usd.toFixed(4)}/$${spend.cap.toFixed(2)} over ${spend.requests} reqs | ` +
                    `${cache} | memory: ${bot.memory.windowSize} lines, ${bot.memory.noteCount} notes`
                );
            }
        },
        {
            name: '!ai-forget',
            level: LEVEL.ADMIN,
            help: 'Clear the rolling chat context, or one viewer\'s saved note.',
            usage: '!ai-forget [@user]',
            handler: ({ args, bot }) => {
                if (args.length === 0) {
                    bot.memory.clear();
                    return '🧽 Cleared the rolling chat context.';
                }
                const target = args[0].replace(/^@+/, '').toLowerCase();
                bot.memory.setNote(target, null);
                return `🧽 Forgot what I knew about ${target}.`;
            }
        },
        {
            name: '!autopost',
            level: LEVEL.ADMIN,
            help: 'Toggle periodic socials posting.',
            usage: '!autopost on|off',
            handler: ({ args, bot }) => {
                if (args.length === 0) {
                    return `🔧 Auto-posting is ${bot.autopost.isEnabled ? 'enabled' : 'disabled'}. Use !autopost on|off`;
                }
                const action = args[0].toLowerCase();
                if (['on', 'enable', 'true'].includes(action)) {
                    bot.autopost.start();
                    return `✅ Auto-posting enabled — every ${humanDuration(config.autopost.intervalMs)}.`;
                }
                if (['off', 'disable', 'false'].includes(action)) {
                    bot.autopost.stop();
                    return '❌ Auto-posting disabled.';
                }
                return '❓ Usage: !autopost on|off';
            }
        },
        {
            name: '!status',
            aliases: ['!botinfo'],
            level: LEVEL.ADMIN,
            help: 'Full bot health report.',
            handler: ({ bot }) => {
                const events = bot.events?.activeNames ?? [];
                return (
                    `🧑🏻‍🍳 v${bot.version} | up ${humanDuration(Date.now() - bot.startedAt)} | ` +
                    `${bot.registry.size} commands | chat ${bot.chat.isConnected ? '✅' : '❌'} | ` +
                    `events: ${events.length > 0 ? events.join(',') : 'none'} | ` +
                    `autopost ${bot.autopost.isEnabled ? 'on' : 'off'}`
                );
            }
        },
        {
            name: '!adminhelp',
            level: LEVEL.ADMIN,
            help: 'List admin and mod commands.',
            handler: ({ bot }) =>
                `🔧 Admin: ${bot.registry.namesAtLevel(LEVEL.ADMIN).join(', ')} | ` +
                `Mod: ${bot.registry.namesAtLevel(LEVEL.MOD).join(', ')}`
        },
        {
            name: '!restart',
            level: LEVEL.ADMIN,
            help: 'Exit with a non-zero code so the host restarts the bot.',
            handler: async ({ user, bot }) => {
                logger.info(`Restart requested by ${user.userName}`);
                await bot.say(`🔄 Restarting at @${user.displayName}'s request...`);
                // Non-zero exit tells Railway/Render/pm2 to bring it back up.
                setTimeout(() => bot.shutdown(1), 1200);
                return null;
            }
        },
        {
            name: '!shutdown',
            level: LEVEL.ADMIN,
            help: 'Stop the bot cleanly.',
            handler: async ({ user, bot }) => {
                logger.info(`Shutdown requested by ${user.userName}`);
                await bot.say(`🔧 Shutting down at @${user.displayName}'s request...`);
                setTimeout(() => bot.shutdown(0), 1200);
                return null;
            }
        }
    ];
}
