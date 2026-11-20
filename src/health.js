import http from 'node:http';
import { logger } from './logger.js';
import { config } from './config.js';

/**
 * A health endpoint on PORT.
 *
 * PORT was already in the old .env with nothing listening on it, which means the
 * host (Railway/Render both do this) was health-checking a closed port and
 * concluding the service was unhealthy. This answers.
 */
export function startHealthServer(bot) {
    const server = http.createServer((req, res) => {
        if (req.url !== '/healthz' && req.url !== '/') {
            res.writeHead(404).end();
            return;
        }

        const spend = bot.ledger.summary;
        const healthy = bot.chat.isConnected;
        const body = {
            status: healthy ? 'ok' : 'degraded',
            version: bot.version,
            uptimeSeconds: Math.floor((Date.now() - bot.startedAt) / 1000),
            chat: { connected: bot.chat.isConnected, channel: bot.chat.channel },
            eventsub: bot.events?.activeNames ?? [],
            ai: {
                enabled: bot.state.aiEnabled,
                model: config.ai.model,
                spentTodayUsd: Number(spend.usd.toFixed(4)),
                dailyCapUsd: spend.cap,
                requestsToday: spend.requests
            },
            commands: bot.registry.size
        };

        res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body, null, 2));
    });

    server.on('error', (err) => {
        // A busy port should not take the bot down with it.
        logger.warn(`Health server could not bind to port ${config.port}: ${err.message}`);
    });

    server.listen(config.port, () => logger.info(`Health endpoint on :${config.port}/healthz`));
    return server;
}
