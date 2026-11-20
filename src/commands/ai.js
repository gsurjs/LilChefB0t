import { config } from '../config.js';
import { logger } from '../logger.js';
import { chunkMessage } from '../ai/sanitize.js';

const CHEF = '👨🏻‍🍳';

/**
 * Turn an AI result into chat-ready lines.
 *
 * Every path out of here runs through chunkMessage, which strips leading
 * command characters and splits on word boundaries -- so model output can never
 * decide the first character of a message the bot sends.
 */
export function formatAiReply(result, displayName) {
    if (!result.ok) return [`❌ @${displayName}, ${result.text}`];

    const chunks = chunkMessage(result.text);
    if (chunks.length === 0) return [`❌ @${displayName}, I came back with nothing. Try again?`];

    return chunks.map((chunk, index) => (index === 0 ? `${CHEF} @${displayName}: ${chunk}` : chunk));
}

export function aiCommands() {
    return [
        {
            name: '!chefbot',
            aliases: ['!chef', '!ask'],
            help: 'Ask LilChef anything. Knows live stream info.',
            usage: '!chefbot <your question>',
            userCooldown: config.ai.cooldownMs,
            handler: async ({ user, args, bot }) => {
                if (!bot.state.aiEnabled) {
                    return `🤖 Chef AI is currently disabled. Admins can enable it with !ai-toggle`;
                }
                if (!config.ai.apiKey) {
                    return `❌ @${user.displayName}, AI isn't configured on this bot yet.`;
                }
                if (args.length === 0) {
                    return `${CHEF} @${user.displayName}, ask me something, LET ME COOK! Usage: !chefbot <your question>`;
                }

                const question = args.join(' ');
                logger.info(`AI request from ${user.userName}: ${question}`);

                const result = await bot.ai.ask({
                    username: user.userName,
                    displayName: user.displayName,
                    question
                });

                return formatAiReply(result, user.displayName);
            }
        }
    ];
}
