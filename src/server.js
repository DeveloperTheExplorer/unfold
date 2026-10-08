import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, treeSummary } from './run.js';
import { highlightLines } from './highlight.js';
import {
	createNote, getNote, listNotes, updateNote, deleteNote, addReply, resolveNoteId,
	createPrReview, getPrReview, latestPrReview, updatePrReview, completePrReview, failPrReview,
} from './db.js';
import { exportNotes, postToGitHub } from './notes.js';
import { sourcePreview, resolveIdentifier } from './context.js';
import { linkedLinearIssues } from './linear.js';
import { runPrReview } from './pr-review.js';

const WEB_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'web');

const CONTENT_TYPES = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
};

/**
 * An explicit marker, because a domain object can legitimately carry `status`
 * and `body` fields of its own — a note row does exactly that.
 */
const httpResult = (status, body, headers = {}) => ({ __http: true, status, body, headers });

function send(response, status, body, headers = {}) {
	const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'cache-control': 'no-store',
		...headers,
	});
	response.end(payload);
}

async function readBody(request) {
	const chunks = [];
	let size = 0;
	for await (const chunk of request) {
		size += chunk.length;
		if (size > 2 * 1024 * 1024) throw new Error('Request body too large.');
		chunks.push(chunk);
	}
	if (!chunks.length) return {};
	return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Diff lines with syntax highlighting applied to the code, not the markers. */
async function renderHunk(payload) {
	const html = await highlightLines(payload.lines.map((line) => line.s), payload.language);
	return {
		path: payload.path,
		from: payload.from,
		to: payload.to,
		header: payload.header,
		lines: payload.lines.map((line, index) => ({
			t: line.t, o: line.o, n: line.n, html: html[index] ?? '',
		})),
	};
}

async function renderSource(source, language) {
	if (!source) return null;
	const html = await highlightLines(source.lines.map((line) => line.s), language);
	return {
		path: source.path,
		start: source.start,
		end: source.end,
		totalLines: source.totalLines,
		lines: source.lines.map((line, index) => ({ n: line.n, changed: line.changed, html: html[index] ?? '' })),
	};
}

function descendantHunks(node, out = []) {
	if (node.kind === 'hunk') out.push(node);
	node.children?.forEach((child) => descendantHunks(child, out));
	return out;
}

function fallbackBrief(scope) {
	const paragraphs = String(scope.prBody ?? '')
		.replace(/<!--[^]*?-->/g, '')
		.split(/\n\s*\n/)
		.map((part) => part.replace(/^#{1,6}\s+/gm, '').replace(/^[-*]\s+/gm, '').trim())
		.filter((part) => part && !/^https?:\/\//.test(part))
		.slice(0, 2)
		.join('\n\n')
		.slice(0, 1200);
	return paragraphs || `${scope.prTitle ?? 'This pull request'} does not include enough description to establish its intended outcome.`;
}

export async function startServer(options = {}) {
	const run = createRun(options);
	const token = randomBytes(16).toString('hex');
	const { index, db, scope, explainer } = run;

	const notesForScope = (status = 'all') => listNotes(db, { scopeKey: run.scopeKey, status });
	let reviewJob = latestPrReview(db, run.scopeKey);
	// A working-tree scope keeps the same scope key while its files change. Never
	// present a completed review for a different version of the diff.
	if (reviewJob?.content_hash !== index.root.contentHash) reviewJob = null;
	const reviewAge = reviewJob ? Date.now() - Date.parse(reviewJob.started_at) : 0;
	if (reviewJob?.status === 'running' && reviewAge > 31 * 60 * 1000) {
		reviewJob = failPrReview(db, reviewJob.id, 'The Unfold server stopped before this review completed.', reviewJob.thread_id);
	}
	const publicReview = (row) => row ? {
		id: row.id, status: row.status, deep: Boolean(row.deep), body: row.body ?? null,
		model: row.model ?? null, threadId: row.thread_id ?? null,
		activity: row.activity ?? null, error: row.error ?? null,
		startedAt: row.started_at, completedAt: row.completed_at ?? null,
		repoRoot: scope.cwd,
		capabilities: ['repository', 'shell', 'git', 'configured MCPs'],
	} : { status: 'idle', repoRoot: scope.cwd, capabilities: ['repository', 'shell', 'git', 'configured MCPs'] };

	const routes = {
		'GET /api/run': () => ({
			scopeKey: run.scopeKey,
			agent: { name: explainer.agent, model: explainer.model },
			scope: {
				kind: scope.scopeKind, baseRef: scope.baseRef, headRef: scope.headRef,
				baseSha: scope.baseSha?.slice(0, 9), headSha: scope.headSha?.slice(0, 9),
				prNumber: scope.prNumber ?? null, prUrl: scope.prUrl ?? null,
				prTitle: scope.prTitle ?? null, prAuthor: scope.prAuthor ?? null,
				repoRoot: scope.cwd, skipped: scope.skipped ?? [],
			},
			tree: treeSummary(index.root),
			rootPayload: {
				...index.root.payload,
				stepOrder: undefined, // sent separately; the tree carries per-node steps
			},
			stepOrder: index.root.payload.stepOrder ?? [],
			totalSteps: index.root.payload.totalSteps ?? 0,
			totalBlocks: index.root.payload.totalBlocks ?? 0,
			explanations: explainer.knownExplanations(),
			notes: notesForScope(),
			cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
			nodeCount: index.nodes.length,
		}),

		'GET /api/node': async ({ segments }) => {
			const node = index.byId.get(segments[0]);
			if (!node) return httpResult(404, { error: 'No such node.' });
			const context = run.contextFor(node);
			const showsHunks = node.kind === 'block' || node.kind === 'file' || node.kind === 'symbol' || node.kind === 'hunk';
			const hunks = showsHunks
				? await Promise.all(descendantHunks(node).slice(0, node.kind === 'block' ? 160 : 40).map((hunk) => renderHunk(hunk.payload)))
				: [];
			return {
				node: {
					id: node.id, key: node.key, kind: node.kind, label: node.label,
					added: node.added, removed: node.removed,
					hunkCount: node.hunkCount, fileCount: node.fileCount,
					contentHash: node.contentHash, payload: node.payload,
				},
				breadcrumb: (() => {
					const trail = [];
					let current = node;
					while (current.parentId) {
						current = index.byId.get(current.parentId);
						trail.unshift({ id: current.id, label: current.label, kind: current.kind });
					}
					return trail;
				})(),
				hunks,
				source: await renderSource(context?.source, node.payload?.language ?? extname(node.payload?.path ?? '').slice(1)),
				context: context
					? {
						callers: context.callers ?? [], tests: context.tests ?? [],
						dependencies: context.dependencies ?? [], localReferences: context.localReferences ?? [],
						importers: context.importers ?? [], sameFile: context.sameFile ?? [],
						searchedIn: context.searchedIn ?? null, searchedFor: context.searchedFor ?? null,
						searchable: context.searchable ?? false,
					}
					: null,
				explanations: {
					shallow: explainer.cached(node, 'shallow'),
					deep: explainer.cached(node, 'deep'),
				},
				children: node.children.map((child) => ({
					id: child.id, kind: child.kind, label: child.label,
					added: child.added, removed: child.removed,
					symbolKind: child.payload?.symbolKind ?? null,
					explained: Boolean(explainer.cached(child, 'shallow') ?? explainer.cached(child, 'deep')),
				})),
			};
		},

		'POST /api/explain': async ({ segments, body }) => {
			const node = index.byId.get(segments[0]);
			if (!node) return httpResult(404, { error: 'No such node.' });
			const mode = body.mode === 'deep' ? 'deep' : 'shallow';
			try {
				const result = await explainer.explain(node, mode, {
					force: Boolean(body.force),
					budget: { remaining: Number(body.budget) > 0 ? Number(body.budget) : 40 },
				});
				return {
					...result,
					mode,
					cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
					explanations: explainer.knownExplanations(),
				};
			} catch (error) {
				return httpResult(502, { error: String(error.message).slice(0, 600) });
			}
		},

		'POST /api/ask': async ({ segments, body }) => {
			const node = index.byId.get(segments[0]);
			if (!node) return httpResult(404, { error: 'No such node.' });
			const question = String(body.question ?? '').trim();
			if (!question) return httpResult(400, { error: 'Ask a question first.' });
			try {
				const result = await explainer.ask(node, question, Array.isArray(body.history) ? body.history : []);
				return { ...result, cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls } };
			} catch (error) {
				return httpResult(502, { error: String(error.message).slice(0, 600) });
			}
		},

		'POST /api/plan': async ({ body }) => {
			try {
				const result = await explainer.plan(index.root, { force: Boolean(body.force) });
				return {
					...result, generated: true,
					cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
				};
			} catch (error) {
				return {
					chunks: explainer.fallbackPlan(index.root), generated: false,
					warning: `Automatic review plan unavailable: ${String(error.message).slice(0, 260)}`,
					cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
				};
			}
		},

		'GET /api/review': () => {
			if (reviewJob?.id) reviewJob = getPrReview(db, reviewJob.id) ?? reviewJob;
			return publicReview(reviewJob);
		},

		'POST /api/review': ({ body }) => {
			if (reviewJob?.status === 'running') return publicReview(reviewJob);
			const deep = Boolean(body.deep);
			const id = randomUUID();
			reviewJob = createPrReview(db, {
				id, scopeKey: run.scopeKey, contentHash: index.root.contentHash,
				deep, model: options.reviewModel ?? null,
				activity: 'Starting Codex in the repository…',
			});
			const chunks = Array.isArray(body.chunks) ? body.chunks : [];
			void runPrReview({
				scope, index, chunks, deep, model: options.reviewModel,
				onProgress: ({ activity, threadId }) => {
					reviewJob = updatePrReview(db, id, {
						activity, ...(threadId ? { thread_id: threadId } : {}),
					});
				},
			}).then((result) => {
				reviewJob = completePrReview(db, id, result);
			}).catch((error) => {
				reviewJob = failPrReview(db, id, error.message, error.threadId ?? reviewJob?.thread_id ?? null);
			});
			return publicReview(reviewJob);
		},

		'POST /api/brief': async () => {
			if (scope.scopeKind !== 'pr') return { body: fallbackBrief(scope), generated: false, linearIssues: [] };
			const linearIssues = await linkedLinearIssues(scope.prBody);
			const sources = linearIssues.map(({ identifier, title, url, state, project, resolved, error }) => ({
				identifier, title, url, state, project, resolved, error,
			}));
			try {
				const result = await explainer.brief(index.root, linearIssues);
				return {
					...result, generated: true, linearIssues: sources,
					cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
				};
			} catch (error) {
				return {
					body: fallbackBrief(scope), generated: false, linearIssues: sources,
					warning: `Automatic summary unavailable: ${String(error.message).slice(0, 220)}`,
					cost: { totalUsd: explainer.totalCostUsd, calls: explainer.calls },
				};
			}
		},

		'GET /api/source': async ({ query }) => {
			const preview = sourcePreview(scope, query.get('path'), Number(query.get('line')) || 1);
			if (!preview) return httpResult(404, { error: 'Could not read that source location.' });
			return { ...preview, source: await renderSource(preview, extname(preview.path).slice(1)) };
		},

		'GET /api/resolve': ({ query }) => {
			const target = resolveIdentifier(scope, {
				path: query.get('path'), name: query.get('name'), line: Number(query.get('line')) || 1,
			});
			return target ? { target } : httpResult(404, { error: `No reliable definition found for ${query.get('name') ?? 'that identifier'}.` });
		},

		// The file view is a fallback, so it is only serialised when asked for.
		'GET /api/files': () => ({ tree: treeSummary(index.fileRoot) }),

		'GET /api/notes': ({ query }) => notesForScope(query.get('status') ?? 'all'),

		'POST /api/notes': ({ body }) => {
			if (!body.body?.trim()) return httpResult(400, { error: 'A note needs a body.' });
			return createNote(db, {
				scopeKey: run.scopeKey, nodeKey: body.nodeKey ?? null, path: body.path,
				side: body.side === 'deletions' ? 'deletions' : 'additions',
				startLine: Number(body.startLine), endLine: Number(body.endLine ?? body.startLine),
				code: body.code ?? null, body: body.body.trim(),
			});
		},

		'PATCH /api/notes': ({ segments, body }) => {
			const id = resolveNoteId(db, segments[0]);
			return updateNote(db, id, {
				body: body.body, status: body.status, posted_url: body.postedUrl,
			});
		},

		'DELETE /api/notes': ({ segments }) => {
			deleteNote(db, resolveNoteId(db, segments[0]));
			return { deleted: true };
		},

		'POST /api/replies': ({ segments, body }) => {
			const id = resolveNoteId(db, segments[0]);
			if (!body.body?.trim()) return httpResult(400, { error: 'A reply needs a body.' });
			return addReply(db, id, body.author === 'agent' ? 'agent' : 'user', body.body.trim());
		},

		'GET /api/export': ({ query }) => {
			const format = query.get('format') ?? 'json';
			const notes = notesForScope(query.get('status') ?? 'open');
			const text = exportNotes(notes, format, { title: scope.prTitle ?? scope.headRef });
			return httpResult(200, text, { 'content-type': 'text/plain; charset=utf-8' });
		},

		'POST /api/github': ({ body }) => {
			try {
				return postToGitHub(db, scope, {
					notes: notesForScope('open'),
					summary: body.summary ?? '',
					dryRun: Boolean(body.dryRun),
				});
			} catch (error) {
				return httpResult(400, { error: String(error.message).slice(0, 600) });
			}
		},
	};

	const server = createServer(async (request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		const path = url.pathname;

		try {
			// Loopback-only for every route, not just the API: a page served to a
			// rebound host must not be able to read anything at all.
			const host = request.headers.host ?? '';
			if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
				return send(response, 403, { error: 'Only loopback requests are served.' });
			}
			const provided = request.headers['x-unfold-token'] ?? url.searchParams.get('token');

			if (path.startsWith('/api/')) {
				if (provided !== token) return send(response, 401, { error: 'Bad or missing token.' });

				const [, , group, first, ...rest] = path.split('/');
				const key = `${request.method} /api/${group}`;
				const handler = routes[key];
				if (!handler) return send(response, 404, { error: `No route for ${key}.` });

				const body = ['POST', 'PATCH', 'PUT'].includes(request.method) ? await readBody(request) : {};
				const result = await handler({ segments: [first, ...rest].filter(Boolean), query: url.searchParams, body });
				if (result && typeof result === 'object' && result.__http === true) {
					return send(response, result.status, result.body, result.headers ?? {});
				}
				return send(response, 200, result);
			}

			const file = path === '/' ? 'index.html' : path.replace(/^\/+/, '');
			if (file.includes('..')) return send(response, 400, { error: 'Bad path.' });
			// The document carries the token, so serving it is itself privileged.
			// The other assets hold no secrets and stay open so the page can load.
			if (file === 'index.html' && provided !== token) {
				return send(response, 401, { error: 'Bad or missing token. Open the URL unfold printed.' });
			}
			let content;
			try {
				content = await readFile(join(WEB_ROOT, file));
			} catch {
				return send(response, 404, { error: `No such asset: ${file}` });
			}
			const type = CONTENT_TYPES[extname(file)] ?? 'application/octet-stream';
			if (file === 'index.html') {
				const html = content.toString('utf8').replace('__UNFOLD_TOKEN__', token);
				return send(response, 200, html, { 'content-type': type });
			}
			return send(response, 200, content, { 'content-type': type });
		} catch (error) {
			return send(response, 500, { error: String(error.message).slice(0, 600) });
		}
	});

	const port = options.port ?? 4380;
	await new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', resolve);
	});

	return { server, run, token, url: `http://127.0.0.1:${server.address().port}/?token=${token}` };
}
