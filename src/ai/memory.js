import { JsonStore } from '../store.js';
import { paths, config } from '../config.js';

const MAX_LINE_LENGTH = 300;
const MAX_NOTE_LENGTH = 200;
const MAX_NOTES = 500;

/**
 * What the bot remembers.
 *
 * Two different lifetimes, deliberately kept apart:
 *
 *  - The rolling chat window is in-memory and dies with the process. It is what
 *    makes a reply feel like it is part of the conversation instead of a cold
 *    one-shot, and it is worthless once the stream ends.
 *  - Per-user notes are persisted. These are things a viewer told the bot that
 *    should survive a restart ("I'm vegetarian", "I play on Switch").
 */
export class ChatMemory {
    #window = [];
    #notesStore;
    #limit;

    constructor({ limit = config.ai.memoryWindow, file = paths.notes } = {}) {
        this.#limit = limit;
        this.#notesStore = new JsonStore(file, { users: {} });
    }

    async load() {
        await this.#notesStore.load();
        this.#notesStore.data.users ??= {};
        return this;
    }

    /** Record a chat line. Called for every message, so it stays cheap. */
    remember({ username, displayName, text, isBot = false }) {
        const clean = String(text).replace(/\s+/g, ' ').trim().slice(0, MAX_LINE_LENGTH);
        if (!clean) return;
        this.#window.push({
            who: displayName || username,
            text: clean,
            isBot,
            at: Date.now()
        });
        if (this.#window.length > this.#limit) {
            this.#window.splice(0, this.#window.length - this.#limit);
        }
    }

    /**
     * The recent-chat block handed to Claude.
     *
     * `exclude` drops the triggering message, which is passed separately as the
     * actual user turn -- otherwise the model sees the question twice.
     */
    recentChat({ exclude = 0 } = {}) {
        const lines = exclude > 0 ? this.#window.slice(0, -exclude) : this.#window;
        if (lines.length === 0) return '';
        return lines.map((entry) => `${entry.isBot ? 'LilChef' : entry.who}: ${entry.text}`).join('\n');
    }

    get windowSize() {
        return this.#window.length;
    }

    clear() {
        this.#window = [];
    }

    getNote(username) {
        return this.#notesStore.data.users[username.toLowerCase()]?.note ?? null;
    }

    setNote(username, note) {
        const key = username.toLowerCase();
        const users = this.#notesStore.data.users;

        if (!note) {
            delete users[key];
        } else {
            users[key] = { note: String(note).slice(0, MAX_NOTE_LENGTH), at: Date.now() };
        }

        // Bound the file: drop the least recently updated notes past the cap.
        const keys = Object.keys(users);
        if (keys.length > MAX_NOTES) {
            keys
                .sort((a, b) => (users[a].at ?? 0) - (users[b].at ?? 0))
                .slice(0, keys.length - MAX_NOTES)
                .forEach((stale) => delete users[stale]);
        }

        this.#notesStore.touch();
    }

    get noteCount() {
        return Object.keys(this.#notesStore.data.users).length;
    }

    async close() {
        await this.#notesStore.close();
    }
}
