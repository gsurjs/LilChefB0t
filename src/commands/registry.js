import { config } from '../config.js';
import { logger } from '../logger.js';

export const LEVEL = {
    EVERYONE: 'everyone',
    MOD: 'mod',
    ADMIN: 'admin'
};

const PRUNE_INTERVAL_MS = 5 * 60 * 1000;

export const isAdmin = (user) => config.twitch.authorizedUsers.includes(user.userName.toLowerCase());
export const isMod = (user) => user.isMod || user.isBroadcaster || isAdmin(user);

/**
 * Command dispatch, permissions and cooldowns in one place.
 *
 * Two things here are deliberate fixes for the old single-file bot:
 *
 *  - The public command list is generated from what is actually registered, so
 *    !commands cannot drift out of sync with reality again.
 *  - Cooldown maps are pruned on a timer. The old Maps were only ever written
 *    to, so they grew for the lifetime of the process.
 */
export class CommandRegistry {
    #commands = new Map();
    #aliases = new Map();
    #userCooldowns = new Map();
    #globalCooldowns = new Map();
    #pruneTimer = null;

    /**
     * @param {object} def
     * @param {string} def.name          Primary trigger, including the `!`.
     * @param {string[]} [def.aliases]   Extra triggers.
     * @param {string} [def.level]       One of LEVEL.*; defaults to everyone.
     * @param {string} [def.help]        Shown by !help <command>.
     * @param {string} [def.usage]       Argument hint.
     * @param {boolean} [def.hidden]     Keep out of !commands.
     * @param {number} [def.userCooldown]   Per-user cooldown, ms.
     * @param {number} [def.globalCooldown] Channel-wide cooldown, ms.
     * @param {Function} def.handler     (ctx) => string | string[] | null
     */
    register(def) {
        if (!def.name?.startsWith('!')) throw new Error(`Command name must start with "!": ${def.name}`);
        if (this.#commands.has(def.name)) throw new Error(`Duplicate command: ${def.name}`);

        const command = {
            level: LEVEL.EVERYONE,
            aliases: [],
            hidden: false,
            userCooldown: 0,
            globalCooldown: 0,
            ...def
        };
        this.#commands.set(command.name, command);
        for (const alias of command.aliases) {
            if (this.#aliases.has(alias)) throw new Error(`Duplicate alias: ${alias}`);
            this.#aliases.set(alias, command.name);
        }
        return this;
    }

    registerAll(defs) {
        for (const def of defs) this.register(def);
        return this;
    }

    resolve(token) {
        const name = token.toLowerCase();
        return this.#commands.get(name) ?? this.#commands.get(this.#aliases.get(name));
    }

    #allows(command, user) {
        if (command.level === LEVEL.ADMIN) return isAdmin(user);
        if (command.level === LEVEL.MOD) return isMod(user);
        return true;
    }

    /** Returns remaining ms, or 0 when ready. Admins skip cooldowns. */
    #cooldownRemaining(command, user) {
        if (isAdmin(user)) return 0;
        const now = Date.now();

        if (command.globalCooldown > 0) {
            const last = this.#globalCooldowns.get(command.name) ?? 0;
            const left = command.globalCooldown - (now - last);
            if (left > 0) return left;
        }
        if (command.userCooldown > 0) {
            const key = `${command.name}:${user.userName}`;
            const last = this.#userCooldowns.get(key) ?? 0;
            const left = command.userCooldown - (now - last);
            if (left > 0) return left;
        }
        return 0;
    }

    #markUsed(command, user) {
        const now = Date.now();
        if (command.globalCooldown > 0) this.#globalCooldowns.set(command.name, now);
        if (command.userCooldown > 0) this.#userCooldowns.set(`${command.name}:${user.userName}`, now);
    }

    /**
     * Run a command if `text` starts with one.
     * Returns true when a command was recognised (even if it was denied).
     */
    async dispatch(ctx) {
        const [token, ...args] = ctx.text.trim().split(/\s+/);
        if (!token?.startsWith('!')) return false;

        const command = this.resolve(token);
        if (!command) return false;

        if (!this.#allows(command, ctx.user)) {
            const needed = command.level === LEVEL.ADMIN ? 'admin' : 'moderator';
            logger.info(`Denied ${command.name} to ${ctx.user.userName} (${needed} required)`);
            await ctx.reply(`@${ctx.user.displayName}, ${needed} privileges required for ${command.name}.`);
            return true;
        }

        const waitMs = this.#cooldownRemaining(command, ctx.user);
        if (waitMs > 0) {
            // Channel-wide cooldowns stay silent so a spammed command cannot be
            // turned into bot spam of its own.
            if (command.userCooldown > 0 && command.globalCooldown === 0) {
                await ctx.reply(
                    `@${ctx.user.displayName}, ${Math.ceil(waitMs / 1000)}s before you can use ${command.name} again.`
                );
            }
            return true;
        }

        try {
            const response = await command.handler({ ...ctx, args, command });
            this.#markUsed(command, ctx.user);
            for (const line of [response].flat()) {
                if (line) await ctx.reply(line);
            }
        } catch (err) {
            logger.error(`Command ${command.name} threw:`, err);
            await ctx.reply(`@${ctx.user.displayName}, something went wrong with ${command.name}.`);
        }
        return true;
    }

    /** Public, non-hidden commands, for !commands. */
    publicNames() {
        return [...this.#commands.values()]
            .filter((command) => !command.hidden && command.level === LEVEL.EVERYONE)
            .map((command) => command.name)
            .sort();
    }

    namesAtLevel(level) {
        return [...this.#commands.values()]
            .filter((command) => command.level === level)
            .map((command) => command.name)
            .sort();
    }

    get size() {
        return this.#commands.size;
    }

    startPruning() {
        this.#pruneTimer = setInterval(() => {
            const now = Date.now();
            let dropped = 0;
            for (const [key, at] of this.#userCooldowns) {
                // An hour is longer than any cooldown here, so this is always safe.
                if (now - at > 60 * 60 * 1000) {
                    this.#userCooldowns.delete(key);
                    dropped += 1;
                }
            }
            if (dropped > 0) logger.debug(`Pruned ${dropped} stale cooldown entries`);
        }, PRUNE_INTERVAL_MS);
        this.#pruneTimer.unref?.();
        return this;
    }

    stop() {
        if (this.#pruneTimer) clearInterval(this.#pruneTimer);
        this.#pruneTimer = null;
    }
}
