import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SpendLedger } from '../src/ai/budget.js';
import { JsonStore } from '../src/store.js';

const today = () => new Date().toISOString().slice(0, 10);

async function ledgerFile(contents) {
    const dir = await mkdtemp(path.join(tmpdir(), 'chefbot-budget-'));
    const file = path.join(dir, 'budget.json');
    await writeFile(file, JSON.stringify(contents), 'utf8');
    return file;
}

/**
 * The rollover runs on every canSpend() and every summary read, i.e. on every
 * AI request. It had been reassigning `store.data`, which JsonStore exposed as
 * a getter only -- so at the first UTC midnight after deploy it threw, and
 * because the throw landed before the day was updated, it threw again on every
 * subsequent call. All AI commands went down until restarted.
 */
test('a ledger from a previous day rolls over instead of throwing', async () => {
    const file = await ledgerFile({
        day: '2020-01-01',
        usd: 1.23,
        requests: 7,
        totals: { 'claude-sonnet-5-5': { input: 10, output: 5, cached: 0, usd: 1.23 } }
    });

    const ledger = await new SpendLedger({ cap: 2, file }).load();

    // Each of these independently triggers the rollover.
    assert.doesNotThrow(() => ledger.canSpend(), 'canSpend must survive a stale day');
    assert.doesNotThrow(() => ledger.summary, 'summary must survive a stale day');

    const summary = ledger.summary;
    assert.equal(summary.day, today(), 'the day advances');
    assert.equal(summary.usd, 0, "yesterday's spend does not carry over");
    assert.equal(summary.requests, 0);
    assert.equal(ledger.canSpend(), true, 'and the cap frees up again');

    await ledger.close();
});

test('rolling over twice in a row is stable', async () => {
    const file = await ledgerFile({ day: '2020-01-01', usd: 5, requests: 3, totals: {} });
    const ledger = await new SpendLedger({ cap: 2, file }).load();

    for (let i = 0; i < 3; i += 1) {
        assert.doesNotThrow(() => ledger.canSpend(), `call ${i + 1}`);
    }
    assert.equal(ledger.summary.usd, 0);
    await ledger.close();
});

test('the rolled-over ledger persists, so a restart does not resurrect old spend', async () => {
    const file = await ledgerFile({ day: '2020-01-01', usd: 9.99, requests: 1, totals: {} });

    const ledger = await new SpendLedger({ cap: 2, file }).load();
    ledger.canSpend();
    await ledger.close();

    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.day, today());
    assert.equal(written.usd, 0);
});

test('spend accumulates and the cap stops further requests', async () => {
    const file = await ledgerFile({ day: today(), usd: 0, requests: 0, totals: {} });
    const ledger = await new SpendLedger({ cap: 0.01, file }).load();

    assert.equal(ledger.canSpend(), true);
    // 1M input + 1M output on Sonnet 5.5 is far past a one-cent cap.
    ledger.record('claude-sonnet-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    assert.equal(ledger.canSpend(), false, 'the cap must actually stop spending');

    await ledger.close();
});

test('cached tokens count toward the input total', async () => {
    const file = await ledgerFile({ day: today(), usd: 0, requests: 0, totals: {} });
    const ledger = await new SpendLedger({ cap: 10, file }).load();

    const cost = ledger.record('claude-sonnet-5-5', {
        input_tokens: 100,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 0,
        output_tokens: 0
    });

    // 1000 input tokens at $2/MTok.
    assert.ok(Math.abs(cost - 0.002) < 1e-9, `expected ~0.002, got ${cost}`);
    assert.ok(ledger.summary.cacheHitRate > 0.8);
    await ledger.close();
});

test('JsonStore.data can be replaced as well as read', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'chefbot-store-'));
    const store = new JsonStore(path.join(dir, 's.json'), { a: 1 });

    assert.deepEqual(store.data, { a: 1 });
    assert.doesNotThrow(() => {
        store.data = { b: 2 };
    }, 'assigning must not throw');
    assert.deepEqual(store.data, { b: 2 });

    await store.close();
});
