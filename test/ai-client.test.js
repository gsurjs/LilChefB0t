import test from 'node:test';
import assert from 'node:assert/strict';

import { ClaudeClient } from '../src/ai/client.js';
import { config } from '../src/config.js';

/** Records every request and replays a scripted list of responses. */
function stubAnthropic(responses) {
    const requests = [];
    let index = 0;
    return {
        requests,
        messages: {
            create: async (request) => {
                // Deep-copy so later mutation of `messages` cannot rewrite history.
                requests.push(structuredClone(request));
                const response = responses[Math.min(index, responses.length - 1)];
                index += 1;
                if (response instanceof Error) throw response;
                return response;
            }
        }
    };
}

const textResponse = (text) => ({
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 }
});

const toolResponse = (uses) => ({
    content: [
        { type: 'thinking', thinking: '' },
        ...uses.map((use, i) => ({ type: 'tool_use', id: `tu_${i}`, name: use.name, input: use.input }))
    ],
    stop_reason: 'tool_use',
    usage: { input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 0 }
});

function harness({ responses, executors, model = 'claude-sonnet-5-5' }) {
    const recorded = [];
    const client = stubAnthropic(responses);
    const ai = new ClaudeClient({
        model,
        client,
        persona: { text: 'You are LilChef.' },
        memory: {
            recentChat: () => 'viewer: is he live?',
            getNote: () => null
        },
        ledger: {
            canSpend: () => true,
            record: (m, usage) => {
                recorded.push({ model: m, usage });
                return 0.0001;
            },
            summary: { usd: 0, cap: 2 }
        },
        tools: {
            definitions: [
                { name: 'get_stream_status', description: 'x', input_schema: { type: 'object' }, strict: true },
                { name: 'get_followage', description: 'y', input_schema: { type: 'object' }, strict: true }
            ],
            executors: executors ?? {}
        }
    });
    return { ai, client, recorded };
}

test.before(() => {
    config.ai.apiKey = 'sk-ant-test-placeholder';
});

test('a plain answer comes straight back', async () => {
    const { ai, client } = harness({ responses: [textResponse('Yes, he is live playing Hades II.')] });

    const result = await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'is he live?' });

    assert.equal(result.ok, true);
    assert.equal(result.text, 'Yes, he is live playing Hades II.');
    assert.equal(client.requests.length, 1);
});

test('the request shape matches what Sonnet 5.5 accepts', async () => {
    const { ai, client } = harness({ responses: [textResponse('ok')] });
    await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'hi' });

    const [request] = client.requests;

    // between_tools is Sonnet 5.5's lowest thinking setting; `disabled` is a 400.
    assert.deepEqual(request.thinking, { type: 'between_tools' });
    // Effort lives inside output_config, not at the top level.
    assert.deepEqual(request.output_config, { effort: config.ai.effort });
    // Claude 4.7+ rejects any temperature below the default, so it must be absent.
    assert.equal('temperature' in request, false, 'temperature must never be sent');
    assert.equal('top_p' in request, false);
    assert.equal(request.model, 'claude-sonnet-5-5');
    assert.ok(request.max_tokens > 0);
});

test('the cached prefix holds the persona and the volatile parts stay in the user turn', async () => {
    const { ai, client } = harness({ responses: [textResponse('ok')] });
    await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'what is up?' });

    const [request] = client.requests;
    const [systemBlock] = request.system;

    assert.deepEqual(systemBlock.cache_control, { type: 'ephemeral', ttl: '1h' });
    assert.ok(systemBlock.text.includes('You are LilChef.'));

    // The question and the chat window must not be inside the cached prefix, or
    // the cache would be invalidated on every single message.
    assert.ok(!systemBlock.text.includes('what is up?'));
    assert.ok(!systemBlock.text.includes('is he live?'));
    assert.ok(request.messages[0].content.includes('what is up?'));
    assert.ok(request.messages[0].content.includes('is he live?'), 'recent chat rides in the user turn');
});

test('other models omit thinking rather than sending an invalid value', async () => {
    for (const model of ['claude-opus-5-5', 'claude-haiku-5-5', 'claude-sonnet-5']) {
        const { ai, client } = harness({ responses: [textResponse('ok')], model });
        await ai.ask({ username: 'v', displayName: 'V', question: 'hi' });
        assert.equal('thinking' in client.requests[0], false, `${model} should omit thinking`);
    }
});

test('a tool call is executed and its result is fed back', async () => {
    const calls = [];
    const { ai, client } = harness({
        responses: [toolResponse([{ name: 'get_stream_status', input: {} }]), textResponse('He is live!')],
        executors: {
            get_stream_status: async () => {
                calls.push('get_stream_status');
                return 'The stream is LIVE.';
            }
        }
    });

    const result = await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'is he live?' });

    assert.deepEqual(calls, ['get_stream_status']);
    assert.equal(result.ok, true);
    assert.equal(result.text, 'He is live!');
    assert.equal(client.requests.length, 2, 'one call per tool round plus the final answer');

    const followUp = client.requests[1];
    const toolResult = followUp.messages.at(-1);
    assert.equal(toolResult.role, 'user');
    assert.equal(toolResult.content[0].type, 'tool_result');
    assert.equal(toolResult.content[0].content, 'The stream is LIVE.');
});

test('the full assistant turn is replayed, including thinking blocks', async () => {
    const { ai, client } = harness({
        responses: [toolResponse([{ name: 'get_stream_status', input: {} }]), textResponse('done')],
        executors: { get_stream_status: async () => 'live' }
    });

    await ai.ask({ username: 'v', displayName: 'V', question: 'q' });

    const assistantTurn = client.requests[1].messages.find((m) => m.role === 'assistant');
    assert.ok(assistantTurn, 'assistant turn is replayed');
    assert.ok(
        assistantTurn.content.some((block) => block.type === 'thinking'),
        'thinking blocks must be passed back unchanged'
    );
});

test('parallel tool calls return every result in a single user message', async () => {
    const { ai, client } = harness({
        responses: [
            toolResponse([
                { name: 'get_stream_status', input: {} },
                { name: 'get_followage', input: { username: 'viewer' } }
            ]),
            textResponse('Live, and you have followed 40 days.')
        ],
        executors: {
            get_stream_status: async () => 'LIVE',
            get_followage: async () => '40 days'
        }
    });

    await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'status?' });

    const toolTurn = client.requests[1].messages.at(-1);
    assert.equal(toolTurn.role, 'user');
    assert.equal(toolTurn.content.length, 2, 'both results in ONE message, not split across turns');
    assert.ok(toolTurn.content.every((block) => block.type === 'tool_result'));
});

test('a failing tool returns an error result instead of being dropped', async () => {
    const { ai, client } = harness({
        responses: [toolResponse([{ name: 'get_followage', input: { username: 'nobody' } }]), textResponse('Could not check.')],
        executors: {
            get_followage: async () => {
                throw new Error('Helix 401');
            }
        }
    });

    const result = await ai.ask({ username: 'v', displayName: 'V', question: 'followage?' });

    const block = client.requests[1].messages.at(-1).content[0];
    assert.equal(block.type, 'tool_result');
    assert.equal(block.is_error, true);
    assert.match(block.content, /Helix 401/);
    assert.equal(result.ok, true, 'the model still gets to answer');
});

test('an unknown tool name is reported back rather than crashing', async () => {
    const { ai, client } = harness({
        responses: [toolResponse([{ name: 'launch_missiles', input: {} }]), textResponse('nope')],
        executors: {}
    });

    await ai.ask({ username: 'v', displayName: 'V', question: 'q' });

    const block = client.requests[1].messages.at(-1).content[0];
    assert.equal(block.is_error, true);
});

test('a refusal is surfaced without reading content as an answer', async () => {
    const { ai } = harness({
        responses: [
            {
                content: [],
                stop_reason: 'refusal',
                stop_details: { type: 'refusal', category: 'cyber' },
                usage: { input_tokens: 50, output_tokens: 0 }
            }
        ]
    });

    const result = await ai.ask({ username: 'v', displayName: 'V', question: 'do something bad' });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'refusal');
});

test('a tool loop that never settles is capped', async () => {
    const { ai, client } = harness({
        responses: [toolResponse([{ name: 'get_stream_status', input: {} }])], // repeats forever
        executors: { get_stream_status: async () => 'LIVE' }
    });

    const result = await ai.ask({ username: 'v', displayName: 'V', question: 'loop' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'tool_loop');
    assert.equal(client.requests.length, 3, 'capped at MAX_TOOL_ROUNDS');
});

test('usage is recorded for every round, not just the last', async () => {
    const { ai, recorded } = harness({
        responses: [toolResponse([{ name: 'get_stream_status', input: {} }]), textResponse('done')],
        executors: { get_stream_status: async () => 'LIVE' }
    });

    await ai.ask({ username: 'v', displayName: 'V', question: 'q' });
    assert.equal(recorded.length, 2, 'both API calls are billed and counted');
});

test('the daily cap short-circuits before any API call', async () => {
    const client = stubAnthropic([textResponse('should not happen')]);
    const ai = new ClaudeClient({
        client,
        persona: { text: 'p' },
        memory: { recentChat: () => '', getNote: () => null },
        ledger: { canSpend: () => false, record: () => 0, summary: { usd: 2, cap: 2 } },
        tools: { definitions: [], executors: {} }
    });

    const result = await ai.ask({ username: 'v', displayName: 'V', question: 'q' });

    assert.equal(result.ok, false);
    assert.equal(result.reason, 'budget');
    assert.equal(client.requests.length, 0, 'no money spent past the cap');
});

test('a saved viewer note is injected into the user turn', async () => {
    const client = stubAnthropic([textResponse('ok')]);
    const ai = new ClaudeClient({
        client,
        persona: { text: 'p' },
        memory: { recentChat: () => '', getNote: () => 'plays on Switch' },
        ledger: { canSpend: () => true, record: () => 0, summary: { usd: 0, cap: 2 } },
        tools: { definitions: [], executors: {} }
    });

    await ai.ask({ username: 'viewer', displayName: 'Viewer', question: 'what should I play?' });

    assert.match(client.requests[0].messages[0].content, /plays on Switch/);
});

test('event reactions run without tools or chat history', async () => {
    const { ai, client } = harness({ responses: [textResponse('Welcome the raiders!')] });

    const result = await ai.reactToEvent('Someone raided with 40 viewers.');

    assert.equal(result.ok, true);
    assert.equal('tools' in client.requests[0], false, 'no tools on the event path');
    assert.ok(!client.requests[0].messages[0].content.includes('is he live?'), 'no chat history');
});
