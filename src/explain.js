import { spawn } from 'node:child_process';
import { buildPrompt, systemPrompt } from './prompts.js';
import { getExplanation, putExplanation } from './db.js';

const DEFAULT_MODEL = 'sonnet';
const TIMEOUT_MS = 180000;

/** Node kinds that benefit from letting the model check the repository itself. */
const TOOL_KINDS = new Set(['file', 'group', 'root']);

function toolFlags(useTools) {
	return useTools
		? [
			'--allowed-tools', 'Read,Grep,Glob',
			'--disallowed-tools', 'Bash,Edit,Write,Task,WebFetch,WebSearch,NotebookEdit',
		]
		: ['--disallowed-tools', 'Read,Grep,Glob,Bash,Edit,Write,Task,WebFetch,WebSearch,NotebookEdit'];
}

/** One model call. The prompt goes over stdin so its size is not bound by ARG_MAX. */
function runClaude({ prompt, wordCap, model, cwd, useTools }) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'claude',
			[
				'-p', '--output-format', 'json',
				'--model', model,
				...toolFlags(useTools),
				'--permission-mode', 'dontAsk',
				'--strict-mcp-config',
				'--system-prompt', systemPrompt(wordCap),
			],
			{ cwd, stdio: ['pipe', 'pipe', 'pipe'] },
		);
		let stdout = '';
		let stderr = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new Error(`Model call timed out after ${TIMEOUT_MS / 1000}s`));
		}, TIMEOUT_MS);

		child.stdout.on('data', (chunk) => { stdout += chunk; });
		child.stderr.on('data', (chunk) => { stderr += chunk; });
		child.on('error', (error) => { clearTimeout(timer); reject(error); });
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
					model: Object.keys(parsed.modelUsage ?? {})[0] ?? model,
				});
			} catch (error) {
				reject(new Error(`Could not parse model output: ${error.message}`));
			}
		});
		child.stdin.end(prompt);
	});
}

export class Explainer {
	constructor({ db, scope, index, contextFor, model = DEFAULT_MODEL, concurrency = 3, tools = 'synthesis' }) {
		this.db = db;
		this.scope = scope;
		this.index = index;
		this.contextFor = contextFor;
		this.model = model;
		this.concurrency = concurrency;
		this.tools = tools;
		this.active = 0;
		this.queue = [];
		this.inFlight = new Map();
		this.totalCostUsd = 0;
		this.calls = 0;
	}

	/** Cached explanations for every node, so the UI can paint what is already known. */
	knownExplanations() {
		const known = {};
		for (const node of this.index.nodes) {
			for (const mode of ['shallow', 'deep']) {
				const row = getExplanation(this.db, node.key, node.contentHash, mode);
				if (row) {
					known[node.key] = known[node.key] ?? {};
					known[node.key][mode] = row.body;
				}
			}
		}
		return known;
	}

	cached(node, mode) {
		return getExplanation(this.db, node.key, node.contentHash, mode)?.body ?? null;
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
				const worth = node.children.filter((child) => child.kind !== 'hunk');
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
			});

			const result = await this.schedule(() =>
				runClaude({
					prompt, wordCap, model: this.model, cwd: this.scope.cwd,
					useTools: this.useToolsFor(node.kind),
				}),
			);
			this.calls++;
			this.totalCostUsd += result.costUsd ?? 0;
			putExplanation(this.db, {
				nodeKey: node.key, contentHash: node.contentHash, mode,
				body: result.body, model: result.model, costUsd: result.costUsd, durationMs: result.durationMs,
			});
			return { body: result.body, cached: false, costUsd: result.costUsd, promptChars: prompt.length };
		})().finally(() => this.inFlight.delete(key));

		this.inFlight.set(key, work);
		return work;
	}

	knownExplanationsFor(nodes) {
		const known = {};
		for (const node of nodes) {
			for (const mode of ['deep', 'shallow']) {
				const row = getExplanation(this.db, node.key, node.contentHash, mode);
				if (row) {
					known[node.key] = known[node.key] ?? {};
					known[node.key][mode] = row.body;
				}
			}
		}
		return known;
	}
}
