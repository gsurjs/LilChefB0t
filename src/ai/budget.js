import { JsonStore } from '../store.js';
import { logger } from '../logger.js';
import { paths, config } from '../config.js';

/**
 * Base USD per million tokens, from platform.claude.com/docs/en/about-claude/pricing.
 *
 * Only used to estimate spend for the daily cap and `!ai-status`. The Console is
 * the source of truth for billing; this is a guardrail, not an invoice. Cache
 * reads are billed well below base input, so counting them at the input rate
 * makes the estimate conservative (it over-reports rather than under-reports).
 */
const PRICING = {
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-haiku-5-5': { input: 0.1, output: 0.5 },
    'claude-haiku-4-5': { input: 1, output: 5 },
    'claude-fable-5-2': { input: 8, output: 40 }
};
const FALLBACK_PRICE = { input: 5, output: 25 };

const today = () => new Date().toISOString().slice(0, 10);

export class SpendLedger {
    #store;
    #cap;

    constructor({ cap = config.ai.dailyUsdCap, file = paths.budget } = {}) {
        this.#cap = cap;
        this.#store = new JsonStore(file, { day: today(), usd: 0, requests: 0, totals: {} });
    }

    async load() {
        await this.#store.load();
        this.#rollDay();
        return this;
    }

    #rollDay() {
        const day = today();
        if (this.#store.data.day !== day) {
            logger.info(`Spend ledger rolled over to ${day} (yesterday: $${(this.#store.data.usd ?? 0).toFixed(4)})`);
            this.#store.data = { day, usd: 0, requests: 0, totals: {} };
            this.#store.touch();
        }
    }

    /** True when there is still room under today's cap. */
    canSpend() {
        this.#rollDay();
        return this.#cap > 0 && this.#store.data.usd < this.#cap;
    }

    /**
     * Record one API response's usage.
     * `usage` is the `response.usage` object from the Messages API.
     */
    record(model, usage) {
        if (!usage) return 0;
        this.#rollDay();
        const price = PRICING[model] ?? FALLBACK_PRICE;

        // input_tokens counts only tokens after the last cache breakpoint, so the
        // cache fields have to be added in to get the real input total.
        const inputTokens =
            (usage.input_tokens ?? 0) +
            (usage.cache_creation_input_tokens ?? 0) +
            (usage.cache_read_input_tokens ?? 0);
        const outputTokens = usage.output_tokens ?? 0;

        const cost = (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output;

        this.#store.data.usd += cost;
        this.#store.data.requests += 1;
        const totals = (this.#store.data.totals[model] ??= { input: 0, output: 0, cached: 0, usd: 0 });
        totals.input += inputTokens;
        totals.output += outputTokens;
        totals.cached += usage.cache_read_input_tokens ?? 0;
        totals.usd += cost;
        this.#store.touch();

        return cost;
    }

    get summary() {
        this.#rollDay();
        const { usd, requests, totals } = this.#store.data;
        const cached = Object.values(totals).reduce((sum, t) => sum + (t.cached ?? 0), 0);
        const input = Object.values(totals).reduce((sum, t) => sum + (t.input ?? 0), 0);
        return {
            day: this.#store.data.day,
            usd,
            cap: this.#cap,
            requests,
            cacheHitRate: input > 0 ? cached / input : 0,
            remaining: Math.max(0, this.#cap - usd)
        };
    }

    async close() {
        await this.#store.close();
    }
}
