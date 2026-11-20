import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { wrapChatterInput } from './sanitize.js';

/** A tool round is a full API call, so this is also the latency ceiling. */
const MAX_TOOL_ROUNDS = 3;

/**
 * Thinking configuration, per model.
 *
 * Claude Sonnet 5.5 has thinking on by default and rejects
 * `thinking: {type: "disabled"}` outright. Its lowest setting is
 * `between_tools`, which skips up-front thinking (the part that would add
 * seconds before the first token) while still letting the model think between
 * tool calls. That is exactly the tradeoff a chat bot wants: fast replies,
 * but no dumb tool use. It takes no other field and is rejected above effort
 * `high`, which is why CLAUDE_EFFORT is validated down to low/medium/high.
 *
 * Every other current model either has thinking permanently on or defaults to
 * adaptive, so omitting the field entirely is correct and forward-compatible.
 */
function thinkingFor(model) {
    if (model === 'claude-sonnet-5-5') return { type: 'between_tools' };
    return undefined;
}

const OPERATING_RULES = `
## Output contract

You are writing a single Twitch chat message. It must survive in a fast-scrolling chat:

- Two sentences maximum. Under 300 characters. No exceptions, even for complex questions.
- Plain text only. No markdown, no bullet points, no headers, no code blocks.
- Do not start your message with the viewer's name; the bot prefixes it already.
- Do not use a tool for something you already know. Do use one for anything live.
- If a tool fails or returns nothing useful, say so in a few words rather than inventing an answer.
- If you cannot help, say that briefly. Do not apologise more than once and do not explain at length.
`.trim();

export class ClaudeClient {
    #client;
    #tools;
    #persona;
    #memory;
    #ledger;
    #model;

    /** `client` is only passed by tests; production reads ANTHROPIC_API_KEY from the environment. */
    constructor({ persona, memory, ledger, tools, client, model = config.ai.model }) {
        this.#model = model;
        this.#persona = persona;
        this.#memory = memory;
        this.#ledger = ledger;
        this.#tools = tools;
        this.#client = client ?? new Anthropic({ maxRetries: 1, timeout: 20_000 });
    }

    get model() {
        return this.#model;
    }

    /**
     * The cacheable prefix: persona plus the output contract.
     *
     * Everything volatile (recent chat, the viewer's note, the question) goes in
     * the user turn, after the breakpoint, so the prefix stays byte-identical
     * between requests and actually gets cache hits. Check the real hit rate
     * with !ai-status rather than trusting that it worked.
     */
    #systemBlocks() {
        return [
            {
                type: 'text',
                text: `${this.#persona.text}\n\n${OPERATING_RULES}`,
                cache_control: { type: 'ephemeral', ttl: '1h' }
            }
        ];
    }

    #buildUserTurn({ username, displayName, question, includeChat }) {
        const parts = [];

        if (includeChat) {
            const recent = this.#memory.recentChat({ exclude: 1 });
            if (recent) {
                parts.push(`<recent_chat>\n${recent}\n</recent_chat>`);
            }
        }

        const note = this.#memory.getNote(username);
        if (note) {
            parts.push(`<viewer_note>Something you remember about ${displayName}: ${note}</viewer_note>`);
        }

        parts.push(wrapChatterInput(username, question));
        return parts.join('\n\n');
    }

    /**
     * Ask Claude a question on behalf of a viewer.
     * Returns { ok, text, reason } -- never throws.
     */
    async ask({ username, displayName, question, includeChat = true }) {
        if (!config.ai.apiKey) {
            return { ok: false, reason: 'no_key', text: 'AI is not configured (no ANTHROPIC_API_KEY).' };
        }
        if (!this.#ledger.canSpend()) {
            const { usd, cap } = this.#ledger.summary;
            logger.warn(`AI request refused: daily cap reached ($${usd.toFixed(2)} of $${cap.toFixed(2)})`);
            return { ok: false, reason: 'budget', text: "the kitchen's out of budget for today. Back tomorrow!" };
        }

        const messages = [
            { role: 'user', content: this.#buildUserTurn({ username, displayName, question, includeChat }) }
        ];

        try {
            return await this.#runLoop(messages, { username, displayName });
        } catch (err) {
            return this.#describeError(err);
        }
    }

    /**
     * Generate a reaction to a stream event (raid, sub, cheer).
     *
     * No tools and no chat history: these fire on their own schedule, need to be
     * fast, and have everything they need in the prompt.
     */
    async reactToEvent(instruction) {
        if (!config.ai.apiKey || !this.#ledger.canSpend()) return { ok: false, reason: 'unavailable' };

        try {
            const response = await this.#create({
                system: this.#systemBlocks(),
                messages: [
                    {
                        role: 'user',
                        content: `${instruction}\n\nWrite the single chat message now. One sentence. No tools needed.`
                    }
                ],
                tools: undefined
            });
            this.#ledger.record(this.#model, response.usage);

            if (response.stop_reason === 'refusal') return { ok: false, reason: 'refusal' };
            return { ok: true, text: this.#textOf(response) };
        } catch (err) {
            logger.warn(`Event reaction failed: ${err.message}`);
            return { ok: false, reason: 'error' };
        }
    }

    async #runLoop(messages, ctx) {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
            const response = await this.#create({
                system: this.#systemBlocks(),
                messages,
                tools: this.#tools.definitions
            });

            const cost = this.#ledger.record(this.#model, response.usage);
            logger.debug(
                `Claude round ${round + 1}: stop=${response.stop_reason} ` +
                    `in=${response.usage?.input_tokens} cached=${response.usage?.cache_read_input_tokens} ` +
                    `out=${response.usage?.output_tokens} est=$${cost.toFixed(5)}`
            );

            // Always check stop_reason before reading content.
            if (response.stop_reason === 'refusal') {
                logger.info(`Claude declined (${response.stop_details?.category ?? 'unspecified'})`);
                return { ok: false, reason: 'refusal', text: "that one's not on the menu." };
            }

            const toolUses = response.content.filter((block) => block.type === 'tool_use');
            if (toolUses.length === 0) {
                const text = this.#textOf(response);
                if (!text) {
                    return { ok: false, reason: 'empty', text: 'came back with nothing. Try again?' };
                }
                if (response.stop_reason === 'max_tokens') {
                    logger.warn('Claude hit max_tokens — raise CLAUDE_MAX_TOKENS if replies are being cut off');
                }
                return { ok: true, text };
            }

            // Preserve the whole assistant turn, including thinking and
            // progress-update blocks, which must be replayed unchanged.
            messages.push({ role: 'assistant', content: response.content });

            // Parallel tool calls must come back as tool_result blocks in ONE
            // user message, or the model learns to stop calling them in parallel.
            const results = await Promise.all(toolUses.map((use) => this.#runTool(use, ctx)));
            messages.push({ role: 'user', content: results });
        }

        logger.warn(`Claude used all ${MAX_TOOL_ROUNDS} tool rounds without answering`);
        return { ok: false, reason: 'tool_loop', text: 'got lost in the pantry. Ask me again?' };
    }

    async #runTool(use, ctx) {
        const executor = this.#tools.executors[use.name];
        if (!executor) {
            logger.error(`Claude called an unknown tool: ${use.name}`);
            return { type: 'tool_result', tool_use_id: use.id, is_error: true, content: 'No such tool.' };
        }

        try {
            // The SDK hands back parsed input; never string-match the raw JSON.
            const output = await executor(use.input ?? {}, ctx);
            logger.debug(`Tool ${use.name}(${JSON.stringify(use.input)}) -> ${String(output).slice(0, 120)}`);
            return { type: 'tool_result', tool_use_id: use.id, content: String(output) };
        } catch (err) {
            logger.warn(`Tool ${use.name} failed: ${err.message}`);
            // Report the failure instead of dropping the block, so the model can
            // tell chat it does not know rather than stalling.
            return {
                type: 'tool_result',
                tool_use_id: use.id,
                is_error: true,
                content: `That lookup failed: ${err.message}`
            };
        }
    }

    #create({ system, messages, tools }) {
        const request = {
            model: this.#model,
            max_tokens: config.ai.maxTokens,
            // Effort is the cost/latency dial. `temperature` is deliberately
            // absent: Claude 4.7 and later reject any value below the default.
            output_config: { effort: config.ai.effort },
            system,
            messages
        };

        const thinking = thinkingFor(this.#model);
        if (thinking) request.thinking = thinking;
        if (tools?.length) request.tools = tools;

        return this.#client.messages.create(request).catch(async (err) => {
            // A model swap via CLAUDE_MODEL can invalidate the thinking setting.
            // Retry once without it rather than taking the bot down.
            if (request.thinking && err instanceof Anthropic.BadRequestError && /thinking/i.test(err.message)) {
                logger.warn(`Model ${this.#model} rejected the thinking setting — retrying without it`);
                delete request.thinking;
                return this.#client.messages.create(request);
            }
            throw err;
        });
    }

    #textOf(response) {
        return response.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text)
            .join(' ')
            .trim();
    }

    /** Most specific error class first; never string-match messages. */
    #describeError(err) {
        if (err instanceof Anthropic.AuthenticationError) {
            logger.error('Claude rejected the API key — check ANTHROPIC_API_KEY');
            return { ok: false, reason: 'auth', text: 'my API key is no good. Tell the chef.' };
        }
        if (err instanceof Anthropic.RateLimitError) {
            logger.warn('Claude rate limited');
            return { ok: false, reason: 'rate_limit', text: 'too many orders at once. Give me a second.' };
        }
        if (err instanceof Anthropic.NotFoundError) {
            logger.error(`Model "${this.#model}" not found — check CLAUDE_MODEL`);
            return { ok: false, reason: 'bad_model', text: 'my model is misconfigured. Tell the chef.' };
        }
        if (err instanceof Anthropic.BadRequestError) {
            logger.error(`Claude rejected the request: ${err.message}`);
            return { ok: false, reason: 'bad_request', text: 'that request came out wrong on my end.' };
        }
        if (err instanceof Anthropic.APIConnectionError) {
            logger.warn(`Could not reach Claude: ${err.message}`);
            return { ok: false, reason: 'offline', text: "can't reach the kitchen right now." };
        }
        if (err instanceof Anthropic.APIError) {
            logger.error(`Claude API error ${err.status}: ${err.message}`);
            return { ok: false, reason: 'api', text: 'something burned on my end. Try again soon.' };
        }
        logger.error('Unexpected AI failure:', err);
        return { ok: false, reason: 'unknown', text: 'failed to cook. Try again later!' };
    }
}
