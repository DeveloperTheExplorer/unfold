import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildPrompt, buildBriefPrompt, buildPlanPrompt, buildQuestionPrompt, systemPrompt } from './prompts.js';
import { getExplanation, putExplanation } from './db.js';

const DEFAULT_AGENT = 'codex';
const TIMEOUT_MS = 180000;
const EXPLANATION_PROMPT_VERSION = 'feature-blocks-v3';
const PLAN_PROMPT_VERSION = 'execution-plan-v3';

/** Node kinds that benefit from letting the model check the repository itself. */
const TOOL_KINDS = new Set(['hunk', 'symbol', 'file', 'group', 'block', 'root']);

function toolFlags(useTools) {
	return useTools
		? [
			'--allowed-tools', 'Read,Grep,Glob',
			'--disallowed-tools', 'Bash,Edit,Write,Task,WebFetch,WebSearch,NotebookEdit',
		]
		: ['--disallowed-tools', 'Read,Grep,Glob,Bash,Edit,Write,Task,WebFetch,WebSearch,NotebookEdit'];
}

export function normalizeAgent(value = DEFAULT_AGENT) {
	const agent = String(value).trim().toLowerCase();
	if (agent === 'codex' || agent === 'openai') return 'codex';
	if (agent === 'claude' || agent === 'claude-code') return 'claude';
	throw new Error(`Unknown agent "${value}". Use --agent codex or --agent claude.`);
}

function unavailableMessage(command, error) {
	if (error?.code === 'ENOENT') {
		return new Error(`The ${command} CLI is not installed or is not on PATH. Install it or choose the other agent with --agent ${command === 'codex' ? 'claude' : 'codex'}.`);
	}
	return error;
}

/** One model call. The prompt goes over stdin so its size is not bound by ARG_MAX. */
function runClaude({ prompt, wordCap, model, cwd, useTools, timeoutMs = TIMEOUT_MS }) {
	return new Promise((resolve, reject) => {
		const modelArgs = model ? ['--model', model] : [];
		const child = spawn(
			'claude',
			[
				'-p', '--output-format', 'json',
				...modelArgs,
				...toolFlags(useTools),
				'--permission-mode', 'dontAsk',
				'--strict-mcp-config',
				'--system-prompt', systemPrompt(wordCap, { useTools }),
			],
			{ cwd, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`Model call timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => { clearTimeout(timer); reject(unavailableMessage('claude', error)); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				reject(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 400) || 'no stderr'}`));
				return;
			}
			try {
				const parsed = JSON.parse(stdout);
				if (parsed.is_error) {
					reject(new Error(String(parsed.result ?? 'model reported an error').slice(0, 400)));
					return;
				}
				resolve({
					body: String(parsed.result ?? '').trim(),
					costUsd: parsed.total_cost_usd ?? null,
					durationMs: parsed.duration_ms ?? null,
					model: Object.keys(parsed.modelUsage ?? {})[0] ?? model ?? 'claude-default',
				});
			} catch (error) {
				reject(new Error(`Could not parse model output: ${error.message}`));
			}
		});
		child.stdin.end(prompt);
	});
}

/** Extract the final assistant message from `codex exec --json` JSONL events. */
export function parseCodexOutput(stdout, model) {
	let body = '';
	let failure = '';
	for (const line of stdout.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let event;
		try {
			event = JSON.parse(line);
		} catch (error) {
			throw new Error(`Could not parse Codex event: ${error.message}`);
		}
		if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
			body = String(event.item.text ?? '').trim();
		}
		if (event.type === 'turn.failed' || event.type === 'error') {
			failure = String(event.error?.message ?? event.message ?? event.error ?? 'Codex reported an error');
		}
	}
	if (failure) throw new Error(failure.slice(0, 400));
	if (!body) throw new Error('Codex completed without a final assistant message.');
	return { body, costUsd: null, model: model ?? 'codex-default' };
}

function runCodex({ prompt, wordCap, model, cwd, useTools, reasoningEffort, timeoutMs = TIMEOUT_MS }) {
	return new Promise((resolve, reject) => {
		const startedAt = Date.now();
		const modelArgs = model ? ['--model', model] : [];
		const reasoningArgs = reasoningEffort ? ['--config', `model_reasoning_effort="${reasoningEffort}"`] : [];
		const child = spawn(
			'codex',
			[
				'exec', '--json', '--ephemeral', '--sandbox', 'read-only', '--color', 'never',
				'--cd', cwd, ...modelArgs, ...reasoningArgs, '-',
			],
			{ cwd, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`Model call timed out after ${timeoutMs / 1000}s`));
		}, timeoutMs);

		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => { clearTimeout(timer); reject(unavailableMessage('codex', error)); });
		child.on('close', (code) => {
			clearTimeout(timer);
			if (code !== 0) {
				let detail = stderr.trim();
				if (!detail && stdout.trim()) {
					try {
						parseCodexOutput(stdout, model);
					} catch (error) {
						detail = error.message;
					}
				}
				reject(new Error(`codex exited ${code}: ${detail.slice(0, 400) || 'no error detail'}`));
				return;
			}
			try {
				resolve({ ...parseCodexOutput(stdout, model), durationMs: Date.now() - startedAt });
			} catch (error) {
				reject(error);
			}
		});
		child.stdin.end(`${systemPrompt(wordCap, { useTools })}\n\n${prompt}`);
	});
}

function runAgent({ agent, ...options }) {
	return agent === 'claude' ? runClaude(options) : runCodex(options);
}

const planBlocks = (root) => root.children.filter((child) => child.kind === 'block' && !child.payload?.appendix);
const cleanPlanText = (value, fallback, max) => {
	const clean = String(value ?? '').replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim();
	return (clean || fallback).slice(0, max);
};
const cleanPlanTitle = (value, fallback) => {
	const title = cleanPlanText(value, fallback, 90).replace(/\s*\[unverified\]\s*/gi, ' ').trim();
	return title || fallback;
};

/** Parse model output but let code—not the model—enforce full block coverage. */
export function normalizeReviewPlan(body, blocks) {
	let text = String(body ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
	if (!text.startsWith('{')) text = text.slice(text.indexOf('{'));
	const parsed = JSON.parse(text);
	const supplied = Array.isArray(parsed) ? parsed : parsed.chunks;
	if (!Array.isArray(supplied)) throw new Error('The review-plan response did not contain a chunks array.');
	const known = new Map(blocks.map((block) => [block.id, block]));
	const seen = new Set();
	const chunks = [];
	for (const item of supplied) {
		const block = known.get(String(item?.blockId ?? ''));
		if (!block || seen.has(block.id)) continue;
		seen.add(block.id);
		const allowedRisk = new Set(['none', 'low', 'medium', 'high', 'critical']);
		const risk = String(item.risk ?? 'none').toLowerCase();
		chunks.push({
			blockId: block.id,
			title: cleanPlanTitle(item.title, block.label),
			description: cleanPlanText(item.description, `Review the behavior centered on ${block.label}.`, 260),
			analysis: cleanPlanText(item.analysis, 'Establish that its inputs, behavior, and downstream effects agree.', 320),
			risk: allowedRisk.has(risk) ? risk : 'none',
			riskReason: cleanPlanText(item.riskReason, '', 220),
		});
	}
	// A malformed or incomplete answer may affect presentation, never coverage.
	for (const block of blocks) {
		if (seen.has(block.id)) continue;
		chunks.push({
			blockId: block.id, title: block.label,
			description: `Review the behavior centered on ${block.label}.`,
			analysis: 'Execution order could not be established automatically; verify its callers and dependencies.',
			risk: 'none', riskReason: '',
		});
	}
	return chunks.map((chunk, index) => ({ ...chunk, executionOrder: index + 1 }));
}

export class Explainer {
	constructor({ db, scope, index, contextFor, agent = DEFAULT_AGENT, model, concurrency = 3, tools = 'synthesis' }) {
		this.db = db;
		this.scope = scope;
		this.index = index;
		this.contextFor = contextFor;
		this.agent = normalizeAgent(agent);
		this.model = model || null;
		this.concurrency = concurrency;
		this.tools = tools;
		this.active = 0;
		this.queue = [];
		this.inFlight = new Map();
		this.totalCostUsd = 0;
		this.calls = 0;
	}

	cacheHash(node) {
		return createHash('sha256')
			.update(node.contentHash)
			.update(`\0${this.agent}\0${this.model ?? 'default'}\0${EXPLANATION_PROMPT_VERSION}`)
			.digest('hex').slice(0, 24);
	}

	planHash(node) {
		return createHash('sha256')
			.update(node.contentHash)
			.update(`\0${this.agent}\0${this.model ?? 'default'}\0${PLAN_PROMPT_VERSION}`)
			.digest('hex').slice(0, 24);
	}

	/** Cached explanations for every node, so the UI can paint what is already known. */
	knownExplanations() {
		const known = {};
		for (const node of this.index.nodes) {
			for (const mode of ['shallow', 'deep']) {
				const row = getExplanation(this.db, node.key, this.cacheHash(node), mode);
				if (row) {
					known[node.key] = known[node.key] ?? {};
					known[node.key][mode] = row.body;
				}
			}
		}
		return known;
	}

	cached(node, mode) {
		return getExplanation(this.db, node.key, this.cacheHash(node), mode)?.body ?? null;
	}

	schedule(task) {
		return new Promise((resolve, reject) => {
			this.queue.push({ task, resolve, reject });
			this.drain();
		});
	}

	drain() {
		while (this.active < this.concurrency && this.queue.length) {
			const { task, resolve, reject } = this.queue.shift();
			this.active++;
			task().then(resolve, reject).finally(() => {
				this.active--;
				this.drain();
			});
		}
	}

	useToolsFor(kind) {
		if (this.tools === 'all') return true;
		if (this.tools === 'none') return false;
		return TOOL_KINDS.has(kind);
	}

	/**
	 * `deep` explains the children first and composes upward, so a parent
	 * summary is built from what its parts actually say. Hunks are left out of
	 * the recursion: a symbol already carries its own diff, so explaining both
	 * is one call for the same content. Click a hunk to explain just that hunk.
	 */
	async explain(node, mode = 'shallow', { force = false, budget = { remaining: 40 } } = {}) {
		const cachedBody = force ? null : this.cached(node, mode);
		if (cachedBody) return { body: cachedBody, cached: true };

		const key = `${node.key}|${mode}`;
		if (this.inFlight.has(key)) return this.inFlight.get(key);

		const work = (async () => {
			if (mode === 'deep') {
				const worth = node.children.filter((child) =>
					child.kind !== 'hunk' && !(node.kind === 'root' && child.payload?.appendix));
				const pending = [];
				for (const child of worth) {
					const childMode = child.children.some((grandchild) => grandchild.kind !== 'hunk') ? 'deep' : 'shallow';
					if (this.cached(child, childMode)) continue;
					if (budget.remaining <= 0) break;
					budget.remaining--;
					pending.push(this.explain(child, childMode, { budget }));
				}
				// The concurrency gate bounds how many actually run at once.
				await Promise.allSettled(pending);
			}

			const ancestors = [];
			let current = node;
			while (current.parentId) {
				current = this.index.byId.get(current.parentId);
				ancestors.unshift(current);
			}
			const { prompt, wordCap } = buildPrompt({
				node,
				ancestors,
				rootPayload: this.index.root.payload,
				context: this.contextFor(node),
				explanations: this.knownExplanationsFor(node.children),
				mode,
				repoRoot: this.scope.cwd,
				canUseTools: this.useToolsFor(node.kind),
			});

			const result = await this.schedule(() =>
				runAgent({
					agent: this.agent, prompt, wordCap, model: this.model, cwd: this.scope.cwd,
					useTools: this.useToolsFor(node.kind),
				}),
			);
			this.calls++;
			this.totalCostUsd += result.costUsd ?? 0;
			putExplanation(this.db, {
				nodeKey: node.key, contentHash: this.cacheHash(node), mode,
				body: result.body, model: result.model, costUsd: result.costUsd, durationMs: result.durationMs,
			});
			return { body: result.body, cached: false, costUsd: result.costUsd, promptChars: prompt.length };
		})().finally(() => this.inFlight.delete(key));

		this.inFlight.set(key, work);
		return work;
	}

	async ask(node, question, history = []) {
		const ancestors = [];
		let current = node;
		while (current.parentId) {
			current = this.index.byId.get(current.parentId);
			ancestors.unshift(current);
		}
		const { prompt, wordCap } = buildQuestionPrompt({
			node, ancestors, rootPayload: this.index.root.payload,
			context: this.contextFor(node), question, history, repoRoot: this.scope.cwd,
		});
		const result = await this.schedule(() => runAgent({
			agent: this.agent, prompt, wordCap, model: this.model, cwd: this.scope.cwd,
			useTools: this.tools !== 'none',
		}));
		this.calls++;
		this.totalCostUsd += result.costUsd ?? 0;
		return { body: result.body, costUsd: result.costUsd, promptChars: prompt.length };
	}

	async brief(node, linearIssues = []) {
		const sourceHash = createHash('sha256')
			.update(node.contentHash)
			.update(`\0${this.agent}\0${this.model ?? 'default'}`)
			.update(String(node.payload?.prTitle ?? ''))
			.update(String(node.payload?.prBody ?? ''))
			.update(JSON.stringify(linearIssues))
			.digest('hex').slice(0, 24);
		const cached = getExplanation(this.db, node.key, sourceHash, 'brief');
		if (cached) return { body: cached.body, cached: true };

		const { prompt, wordCap } = buildBriefPrompt({ rootPayload: node.payload, linearIssues });
		const result = await this.schedule(() => runAgent({
			agent: this.agent, prompt, wordCap, model: this.model, cwd: this.scope.cwd, useTools: false,
		}));
		this.calls++;
		this.totalCostUsd += result.costUsd ?? 0;
		putExplanation(this.db, {
			nodeKey: node.key, contentHash: sourceHash, mode: 'brief',
			body: result.body, model: result.model, costUsd: result.costUsd, durationMs: result.durationMs,
		});
		return { body: result.body, cached: false, costUsd: result.costUsd, promptChars: prompt.length };
	}

	fallbackPlan(node) {
		return normalizeReviewPlan('{"chunks":[]}', planBlocks(node));
	}

	async plan(node, { force = false } = {}) {
		const blocks = planBlocks(node);
		const hash = this.planHash(node);
		const cached = force ? null : getExplanation(this.db, node.key, hash, 'plan');
		if (cached) return { chunks: normalizeReviewPlan(cached.body, blocks), cached: true };
		const key = `${node.key}|plan`;
		if (this.inFlight.has(key)) return this.inFlight.get(key);
		const work = (async () => {
			const { prompt, wordCap } = buildPlanPrompt({
				rootPayload: node.payload, blocks, repoRoot: this.scope.cwd,
			});
			const result = await this.schedule(() => runAgent({
				agent: this.agent, prompt, wordCap, model: this.model, cwd: this.scope.cwd,
				useTools: false, reasoningEffort: 'low', timeoutMs: 120000,
			}));
			const chunks = normalizeReviewPlan(result.body, blocks);
			this.calls++;
			this.totalCostUsd += result.costUsd ?? 0;
			putExplanation(this.db, {
				nodeKey: node.key, contentHash: hash, mode: 'plan', body: JSON.stringify({ chunks }),
				model: result.model, costUsd: result.costUsd, durationMs: result.durationMs,
			});
			return { chunks, cached: false, costUsd: result.costUsd, promptChars: prompt.length };
		})().finally(() => this.inFlight.delete(key));
		this.inFlight.set(key, work);
		return work;
	}

	knownExplanationsFor(nodes) {
		const known = {};
		for (const node of nodes) {
			for (const mode of ['deep', 'shallow']) {
				const row = getExplanation(this.db, node.key, this.cacheHash(node), mode);
				if (row) {
					known[node.key] = known[node.key] ?? {};
					known[node.key][mode] = row.body;
				}
			}
		}
		return known;
	}
}
