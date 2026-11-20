import { createRequire } from 'node:module';

import { config, validateConfig, paths } from './config.js';
import { logger } from './logger.js';
import { createAuthProvider, createChatAuthProvider } from './twitch/auth.js';
import { TwitchApi } from './twitch/api.js';
import { ChatBridge } from './twitch/chat.js';
import { EventBridge } from './twitch/events.js';
import { Persona } from './ai/persona.js';
import { ChatMemory } from './ai/memory.js';
import { SpendLedger } from './ai/budget.js';
import { buildTools } from './ai/tools.js';
import { ClaudeClient } from './ai/client.js';
import { CommandRegistry } from './commands/registry.js';
import { funCommands } from './commands/fun.js';
import { socialCommands } from './commands/social.js';
import { infoCommands } from './commands/info.js';
import { aiCommands, formatAiReply } from './commands/ai.js';
import { modCommands } from './commands/mod.js';
import { adminCommands } from './commands/admin.js';
import { AutoPoster } from './autopost.js';
import { startHealthServer } from './health.js';
import { pick } from './util.js';

const { version } = createRequire(import.meta.url)('../package.json');

/** Per-user cooldown for name-mention replies, kept separate from !chefbot. */
const mentionCooldowns = new Map();

function mentionAllowed(username) {
    const last = mentionCooldowns.get(username) ?? 0;
    if (Date.now() - last < config.ai.mentionCooldownMs) return false;
    mentionCooldowns.set(username, Date.now());
    return true;
}

/** Does this message address the bot by name? */
function addressesBot(text) {
    const name = config.twitch.botUsername;
    if (!name) return false;
    const pattern = new RegExp(`(^|\\s)@?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    return pattern.test(text) || /\blil\s?chef\b/i.test(text);
}

async function main() {
    const { fatal, warnings } = validateConfig();
    for (const warning of warnings) logger.warn(warning);
    if (fatal.length > 0) {
        logger.error('Cannot start:');
        for (const problem of fatal) logger.error(`  • ${problem}`);
        process.exit(1);
    }

    // --- Twitch -----------------------------------------------------------
    // Two providers, because the identity that chats and the identity that
    // calls Helix do not have to be the same account. With a static bot chat
    // token set, chat posts as the bot while the API runs on the broadcaster.
    const { provider, vault } = await createAuthProvider();
    const chatProvider = await createChatAuthProvider(provider);
    const twitchApi = await new TwitchApi(provider).init();
    const chat = new ChatBridge(chatProvider);

    // --- AI ---------------------------------------------------------------
    const persona = await new Persona().load();
    persona.watchForChanges();
    const memory = await new ChatMemory().load();
    const ledger = await new SpendLedger().load();
    const tools = buildTools({ twitchApi, memory });
    const ai = new ClaudeClient({ persona, memory, ledger, tools });

    // --- Commands ---------------------------------------------------------
    const registry = new CommandRegistry()
        .registerAll(funCommands())
        .registerAll(socialCommands())
        .registerAll(infoCommands())
        .registerAll(aiCommands())
        .registerAll(modCommands())
        .registerAll(adminCommands())
        .startPruning();

    const autopost = new AutoPoster({ chat, twitchApi });

    const bot = {
        version,
        startedAt: Date.now(),
        state: { aiEnabled: config.ai.enabledAtBoot && Boolean(config.ai.apiKey), streamLive: false },
        api: twitchApi,
        chat,
        ai,
        memory,
        ledger,
        registry,
        persona,
        autopost,
        events: null,
        say: (text) => chat.say(text),
        shutdown: (code) => void shutdown(code)
    };

    // --- Message pipeline -------------------------------------------------
    chat.onMessage(async ({ username, text, msg }) => {
        const user = msg.userInfo;
        logger.debug(`<${username}> ${text}`);

        // Every message feeds the rolling window, so a reply three messages
        // later still knows what the room was talking about.
        memory.remember({ username, displayName: user.displayName, text });

        const ctx = {
            channel: chat.channel,
            user,
            text,
            msg,
            bot,
            reply: async (response) => {
                await chat.reply(response, msg);
                memory.remember({ username: config.twitch.botUsername, displayName: 'LilChef', text: response, isBot: true });
            },
            say: (response) => chat.say(response)
        };

        if (await registry.dispatch(ctx)) return;

        // Greet genuinely new chatters. `isFirst` is Twitch's own flag, so this
        // fires once per person per channel, not once per session.
        if (msg.isFirst) {
            logger.info(`First-time chatter: ${user.displayName}`);
            await chat.reply(
                pick([
                    `👋 First time in the kitchen, @${user.displayName}? Welcome in!`,
                    `🧑🏻‍🍳 Fresh face! Welcome @${user.displayName}, make yourself at home.`
                ]),
                msg
            );
            return;
        }

        // Someone talking to the bot by name, without a command.
        if (config.ai.respondToMentions && bot.state.aiEnabled && config.ai.apiKey && addressesBot(text)) {
            if (!mentionAllowed(username)) {
                logger.debug(`Mention from ${username} suppressed by cooldown`);
                return;
            }
            logger.info(`Mention from ${username}: ${text}`);
            const result = await ai.ask({
                username,
                displayName: user.displayName,
                question: text
            });
            for (const line of formatAiReply(result, user.displayName)) {
                await ctx.reply(line);
            }
        }
    });

    await chat.connect();

    // --- EventSub ---------------------------------------------------------
    bot.events = new EventBridge({ twitchApi, chat, ai, state: bot.state }).start();

    if (config.autopost.enabledAtBoot) autopost.start();

    const health = startHealthServer(bot);

    const status = await twitchApi.getStreamStatus().catch(() => ({ live: false }));
    bot.state.streamLive = status.live;

    logger.banner(`LilChef v${version} is cooking`, [
        `Channel:    #${config.twitch.channelName} (${status.live ? '🔴 LIVE' : 'offline'})`,
        `Bot:        ${config.twitch.botUsername}`,
        `Commands:   ${registry.size} registered`,
        `AI:         ${
            config.ai.apiKey
                ? `${config.ai.model} @ effort=${config.ai.effort} (${bot.state.aiEnabled ? 'on' : 'off'})`
                : 'not configured'
        }`,
        `Budget:     $${config.ai.dailyUsdCap.toFixed(2)}/day`,
        `EventSub:   ${bot.events.activeNames.join(', ') || 'none'}`,
        `Admins:     ${config.twitch.authorizedUsers.join(', ') || 'none'}`,
        `Autopost:   ${autopost.isEnabled ? 'on' : 'off (!autopost on)'}`
    ]);

    // --- Shutdown ---------------------------------------------------------
    let shuttingDown = false;
    async function shutdown(code = 0) {
        if (shuttingDown) return;
        shuttingDown = true;
        logger.info('Shutting down...');

        autopost.stop();
        registry.stop();
        persona.close();
        bot.events?.stop();
        chat.quit();
        health.close();

        // Flush everything we would otherwise lose: spend ledger, viewer notes,
        // and any token refreshed in the last second.
        await Promise.allSettled([ledger.close(), memory.close(), vault.close()]);
        logger.info('Clean exit.');
        process.exit(code);
    }

    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, () => {
            logger.info(`Received ${signal}`);
            void shutdown(0);
        });
    }

    // Never die silently: log, flush, then let the host restart us.
    process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));
    process.on('uncaughtException', (err) => {
        logger.error('Uncaught exception:', err);
        void shutdown(1);
    });
}

main().catch((err) => {
    logger.error(`Startup failed: ${err.message}`);
    if (err.message.includes('npm run auth')) {
        logger.error(`  Token file expected at: ${paths.tokens}`);
    } else {
        logger.debug(err.stack);
    }
    process.exit(1);
});
