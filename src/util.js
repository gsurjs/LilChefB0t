export const pick = (items) => items[Math.floor(Math.random() * items.length)];

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Strip a leading @ and lowercase, for turning chat input into a username. */
export const cleanUsername = (raw) => String(raw ?? '').replace(/^@+/, '').toLowerCase();

/** "3 hours 12 minutes", "45 minutes", "2 days 4 hours". */
export function humanDuration(ms) {
    const totalMinutes = Math.floor(ms / 60_000);
    if (totalMinutes < 1) return 'less than a minute';

    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const parts = [];
    if (days > 0) parts.push(plural(days, 'day'));
    if (hours > 0) parts.push(plural(hours, 'hour'));
    if (minutes > 0 && days === 0) parts.push(plural(minutes, 'minute'));
    return parts.join(' ');
}
