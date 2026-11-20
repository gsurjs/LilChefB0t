#!/usr/bin/env node
/**
 * One-time Twitch authorization, via Device Code Flow.
 *
 * This replaces pasting a token from twitchtokengenerator.com. That token had
 * no refresh token, so it expired and the bot stopped working -- repeatedly.
 * What this writes to data/tokens.json includes a refresh token, and the bot
 * renews it in the background from then on.
 *
 * Device Code Flow needs no redirect URI, no local web server, and no client
 * secret: you get a code, you type it into twitch.tv/activate, done.
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { startDeviceCodeFlow, exchangeDeviceCode, getTokenInfo } from '@twurple/auth';

import { config, paths } from '../src/config.js';
import { TokenVault, BOT_SCOPES, BROADCASTER_SCOPES } from '../src/twitch/auth.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll Twitch until the user finishes authorizing, or the code expires. */
async function awaitAuthorization(clientId, info, scopes) {
    const deadline = Date.now() + info.expiresIn * 1000;
    const intervalMs = Math.max(info.interval, 1) * 1000;

    while (Date.now() < deadline) {
        await sleep(intervalMs);
        try {
            return await exchangeDeviceCode(clientId, info.deviceCode, scopes);
        } catch {
            // authorization_pending is the normal case; keep polling.
            stdout.write('.');
        }
    }
    throw new Error('The device code expired before it was authorized.');
}

async function authorize({ role, scopes, expectedLogin, vault, intents }) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Authorizing the ${role.toUpperCase()} account${expectedLogin ? ` (${expectedLogin})` : ''}`);
    console.log(`Scopes: ${scopes.join(', ')}`);
    console.log('─'.repeat(60));

    const info = await startDeviceCodeFlow(config.twitch.clientId, scopes);

    console.log(`\n  1. Sign in to Twitch as  ${expectedLogin ?? `the ${role} account`}`);
    console.log(`  2. Open                  ${info.verificationUri}`);
    console.log(`  3. Enter the code        ${info.userCode}\n`);
    console.log(`Waiting for authorization (expires in ${Math.floor(info.expiresIn / 60)} minutes)`);

    const token = await awaitAuthorization(config.twitch.clientId, info, scopes);
    const tokenInfo = await getTokenInfo(token.accessToken, config.twitch.clientId);

    if (!tokenInfo.userId) throw new Error('Twitch returned an app token, not a user token.');

    if (expectedLogin && tokenInfo.userName?.toLowerCase() !== expectedLogin.toLowerCase()) {
        console.warn(
            `\n  ⚠ You authorized as "${tokenInfo.userName}", but .env expects "${expectedLogin}".` +
                '\n    Saving anyway — update .env if this was intentional.'
        );
    }

    const granted = tokenInfo.scopes ?? [];
    const missing = scopes.filter((scope) => !granted.includes(scope));

    vault.save(tokenInfo.userId, token, { intents, login: tokenInfo.userName, role });

    console.log(`\n  ✅ Saved ${tokenInfo.userName} (${tokenInfo.userId})`);
    if (missing.length > 0) {
        console.warn(`  ⚠ Not granted: ${missing.join(', ')}`);
        console.warn('    Features needing those scopes will be skipped at startup.');
    }
    return { tokenInfo, refreshToken: token.refreshToken };
}

/**
 * Print the refresh tokens for hosts with no interactive shell.
 *
 * Railway and friends cannot run this script against their own volume, so the
 * bot accepts these as a first-boot seed instead. They are single-use: the bot
 * spends them on its first refresh and writes the replacement to its token
 * file, which is why that file has to be on a durable volume.
 */
function printDeploySeeds(seeds) {
    const entries = Object.entries(seeds).filter(([, value]) => value);
    if (entries.length === 0) return;

    console.log(`\n${'─'.repeat(60)}`);
    console.log('Deploying somewhere without a shell (Railway, Render, Fly)?');
    console.log('Set these as environment variables there for the first boot:');
    console.log('─'.repeat(60));
    for (const [name, value] of entries) console.log(`\n${name}=${value}`);
    console.log('\n  ⚠ Treat these like passwords. Each is single-use — the bot swaps it');
    console.log('    for a fresh one on first refresh and stores that in its data volume.');
    console.log('    Attach a persistent volume, or you will be re-running this every deploy.');
}

async function main() {
    if (!config.twitch.clientId) {
        console.error('TWITCH_CLIENT_ID is not set in .env.\n');
        console.error('Register an app at https://dev.twitch.tv/console/apps with:');
        console.error('  OAuth Redirect URL : http://localhost');
        console.error('  Client Type        : Public     (recommended; Confidential also works)');
        process.exit(1);
    }

    console.log('\n🧑🏻‍🍳 LilChef — Twitch authorization');
    console.log(`Tokens will be written to ${paths.tokens}`);

    const vault = await new TokenVault().load();
    const rl = createInterface({ input: stdin, output: stdout });

    const seeds = {};

    // Running the bot from the broadcaster's own account is a legitimate setup
    // (no second account to manage). Both roles then live on one Twitch user, so
    // they must be authorized together -- authorizing them in two passes would
    // key both entries to the same user ID and the second would clobber the
    // first, silently dropping whichever scopes it did not request.
    const singleAccount = config.twitch.botUsername === config.twitch.channelName;

    // A static chat token covers chat under the bot's own name, so the bot
    // account never needs to log in here. Everything else -- moderation,
    // followage, EventSub -- then runs on the broadcaster's token, which means
    // the broadcaster needs the moderator scopes too, not just its own.
    const staticChat = Boolean(config.twitch.botChatToken);

    const ALL_SCOPES = [...new Set([...BOT_SCOPES, ...BROADCASTER_SCOPES])];

    try {
        if (singleAccount || staticChat) {
            if (singleAccount) {
                console.log(
                    `\nBOT_USERNAME and CHANNEL_NAME are both "${config.twitch.channelName}", so the bot` +
                        '\nruns as the broadcaster. Authorizing once with the combined scope set.'
                );
            } else {
                console.log(
                    `\nA static chat token is configured, so "${config.twitch.botUsername}" does not need` +
                        `\nto log in — it keeps posting in chat under its own name.` +
                        `\n\nOnly "${config.twitch.channelName}" needs authorizing. Its token will carry the` +
                        '\nmoderator scopes as well, since moderation runs through it.'
                );
            }

            const combined = await authorize({
                role: singleAccount ? 'bot + broadcaster' : 'broadcaster (+ moderation)',
                scopes: ALL_SCOPES,
                expectedLogin: config.twitch.channelName,
                // Keep the chat intent either way: if the static token is ever
                // removed, chat falls back to this account instead of breaking.
                intents: ['chat'],
                vault
            });

            seeds[singleAccount ? 'BOT_REFRESH_TOKEN' : 'BROADCASTER_REFRESH_TOKEN'] = combined.refreshToken;
            await vault.close();

            printDeploySeeds(seeds);
            console.log('\n✅ Done. Start the bot with `npm start`.\n');
            return;
        }

        // The bot account is mandatory: it is what talks in chat and moderates.
        const bot = await authorize({
            role: 'bot',
            scopes: BOT_SCOPES,
            expectedLogin: config.twitch.botUsername,
            intents: ['chat'],
            vault
        });
        seeds.BOT_REFRESH_TOKEN = bot.refreshToken;
        await vault.close();

        console.log('\nThe bot account is enough for chat, commands, moderation and raid alerts.');
        console.log('Authorizing the BROADCASTER account as well adds sub, resub, gift and cheer alerts.');
        console.log('(Twitch only sends those to the broadcaster\'s own token — a mod token cannot see them.)');

        const answer = await rl.question(`\nAuthorize ${config.twitch.channelName} too? [y/N] `);
        if (['y', 'yes'].includes(answer.trim().toLowerCase())) {
            const broadcaster = await authorize({
                role: 'broadcaster',
                scopes: BROADCASTER_SCOPES,
                expectedLogin: config.twitch.channelName,
                intents: [],
                vault
            });
            seeds.BROADCASTER_REFRESH_TOKEN = broadcaster.refreshToken;
            await vault.close();
        } else {
            console.log('Skipped. Re-run `npm run auth` any time to add it.');
        }

        printDeploySeeds(seeds);
        console.log('\n✅ Done. Start the bot with `npm start`.\n');
    } finally {
        rl.close();
        await vault.close();
    }
}

main().catch((err) => {
    console.error(`\n❌ Authorization failed: ${err.message}\n`);
    if (/invalid client|unauthorized/i.test(err.message)) {
        console.error('Check TWITCH_CLIENT_ID, and if the app is Confidential, set TWITCH_CLIENT_SECRET.');
    }
    process.exit(1);
});
