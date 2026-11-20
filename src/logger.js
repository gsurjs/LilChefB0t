const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const stamp = () => new Date().toISOString().slice(11, 19);

const emit = (level, stream, args) => {
    if (LEVELS[level] < threshold) return;
    stream(`${stamp()} ${level.toUpperCase().padEnd(5)}`, ...args);
};

export const logger = {
    debug: (...args) => emit('debug', console.debug, args),
    info: (...args) => emit('info', console.log, args),
    warn: (...args) => emit('warn', console.warn, args),
    error: (...args) => emit('error', console.error, args),

    /** Section header for boot output. */
    banner(title, lines) {
        const bar = '='.repeat(56);
        console.log(`\n${bar}\n  ${title}\n${bar}`);
        for (const line of lines) console.log(`  ${line}`);
        console.log(`${bar}\n`);
    }
};
