import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createRun } from './run.js';
import { startServer } from './server.js';
import { renderTree } from './render-tree.js';
import { createNote, listNotes, updateNote, deleteNote, addReply, resolveNoteId, getNote } from './db.js';
import { exportNotes, postToGitHub } from './notes.js';
import { runPrReview } from './pr-review.js';

const USAGE = `unfold — unfold a pull request top-down

Usage
  unfold [refs] [options]              build the tree and open the review UI
  unfold blocks [refs] [options]       print the feature/bug review blocks and exit
  unfold path [refs] [options]         alias for blocks
  unfold tree [refs] [options]         print the file tree as text and exit
  unfold review [refs] [options]       run the Codex pr-review skill with Unfold's chunk map
  unfold notes <command> [options]     read and write review notes

Refs
  unfold                               current branch against its merge-base (includes uncommitted work)
  unfold main..feature                 an explicit range
  unfold --base main --head feature    the same, spelled out
  unfold --pr 123                      a pull request, by number or URL
  unfold --ref branch                  ignore uncommitted work

Options
  --port <n>         UI port (default 4380)
  --no-open          do not launch a browser
  --agent <name>     explanation agent: codex (default) or claude
  --model <name>     model override for the selected agent
  --review-model <name> model override for the Codex PR reviewer
  --review-effort <level> reasoning effort: low, medium, high, xhigh, or max
  --tools <mode>     repository access for the model: synthesis (default), all, none
  --deep             force the PR review's parallel deep mode
  --json             machine-readable output where it applies

notes commands
  list [--status open|resolved|all] [--format json|xml|md]
  show <id>
  create --file <path> --line <n> [--end-line <n>] [--side additions|deletions] --body <text>
  reply <id> --body <text> [--author user|agent]
  resolve <id> [--body <text>]        reopen <id>        delete <id>
  export --format md|xml|json [--out <file>]
  post [--summary <text>] [--dry-run]  post open notes to the pull request
`;

function parseArgs(argv) {
	const options = { positional: [] };
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (!token.startsWith('--')) { options.positional.push(token); continue; }
		const name = token.slice(2);
		const next = argv[i + 1];
		if (name === 'no-open') options.open = false;
		else if (name === 'dry-run') options.dryRun = true;
		else if (name === 'json') options.json = true;
		else if (next === undefined || next.startsWith('--')) options[camel(name)] = true;
		else { options[camel(name)] = next; i++; }
	}
	return options;
}

const camel = (name) => name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());

/** Positional refs, in the shapes git users already type. */
function scopeFromPositional(options) {
	const [first, second] = options.positional;
	if (!first) return {};
	if (first.includes('...')) {
		const [base, head] = first.split('...');
		return { base: base || undefined, head: head || undefined };
	}
	if (first.includes('..')) {
		const [base, head] = first.split('..');
		return { base: base || undefined, head: head || undefined };
	}
	return second ? { base: first, head: second } : { base: first };
}

function scopeOptions(options) {
	return {
		...scopeFromPositional(options),
		base: options.base ?? scopeFromPositional(options).base,
		head: options.head ?? scopeFromPositional(options).head,
		pr: options.pr,
		ref: options.ref,
		agent: options.agent,
		model: options.model,
		reviewModel: options.reviewModel,
		reviewEffort: options.reviewEffort,
		tools: options.tools,
		port: options.port ? Number(options.port) : undefined,
	};
}

async function commandReview(options) {
	const run = createRun(scopeOptions(options));
	const deep = Boolean(options.deep);
	process.stderr.write(
		`Running ${deep ? 'deep ' : ''}Codex PR review across ${run.index.root.payload.totalBlocks ?? 0} Unfold chunk(s)…\n` +
		`Repository: ${run.scope.cwd}\n`,
	);
	const result = await runPrReview({
		scope: run.scope, index: run.index, deep,
		model: options.reviewModel ?? options.model,
		reasoningEffort: options.reviewEffort,
	});
	if (options.json) {
		process.stdout.write(`${JSON.stringify({
			...result, scopeKey: run.scopeKey, deep, repoRoot: run.scope.cwd,
		}, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${result.body}\n`);
	if (result.threadId) process.stderr.write(`\nContinue with: codex exec resume ${result.threadId} "Follow up on the PR review."\n`);
}

function openBrowser(url) {
	const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
	spawn(opener, [url], { detached: true, stdio: 'ignore' }).unref();
}

async function commandShow(options) {
	const started = await startServer(scopeOptions(options));
	const { scope, index, explainer } = started.run;
	const label = scope.prTitle ? `PR #${scope.prNumber}: ${scope.prTitle}` : `${scope.baseRef} → ${scope.headRef}`;
	const blocks = index.root.children.filter((child) => child.kind === 'block' && !child.payload.appendix);
	process.stdout.write(
		`\n  ${label}\n` +
		`  ${index.root.added} added, ${index.root.removed} removed across ${index.fileRoot.fileCount} file(s)\n` +
		`  ${index.root.payload.totalSteps} code steps across ${blocks.length} candidate review chunk(s)\n` +
		`  ${index.root.payload.overlapCount ?? 0} shared code unit(s) repeated where their effects overlap\n` +
		`  ${(index.root.payload.entryPoints ?? []).length} route(s) touched\n\n` +
		`  Agent: ${explainer.agent}${explainer.model ? ` (${explainer.model})` : ' (current default model)'}\n` +
		`  ${started.url}\n\n` +
		'  Opening the page creates a cached AI review plan; PRs also receive an intent briefing from linked context.\n' +
		'  Ctrl-C to stop.\n\n',
	);
	if (options.open !== false) openBrowser(started.url);
	await new Promise(() => {});
}

function commandTree(options, { reviewBlocks = false } = {}) {
	const run = createRun(scopeOptions(options));
	const root = reviewBlocks ? run.index.root : run.index.fileRoot;
	if (options.json) {
		process.stdout.write(`${JSON.stringify({
			scope: {
				kind: run.scope.scopeKind, baseRef: run.scope.baseRef, headRef: run.scope.headRef,
				prNumber: run.scope.prNumber ?? null,
			},
			nodes: run.index.nodes.map((node) => ({
				id: node.id, key: node.key, kind: node.kind, label: node.label,
				parentId: node.parentId, added: node.added, removed: node.removed,
				path: node.payload?.path ?? null, symbolKind: node.payload?.symbolKind ?? null,
			})),
		}, null, 2)}\n`);
		return;
	}
	process.stdout.write(`${renderTree(root, { showHunks: Boolean(options.hunks) })}\n`);
	if (run.scope.skipped?.length) {
		process.stdout.write(`\nSkipped: ${run.scope.skipped.join(', ')}\n`);
	}
}

/** Subcommands that name a note before any git refs. */
const ID_SUBCOMMANDS = new Set(['show', 'reply', 'resolve', 'reopen', 'delete']);

async function commandNotes(options) {
	const [sub = 'list', ...rest] = options.positional;
	// Strip the subcommand and any note id so the rest can still be read as refs.
	const target = ID_SUBCOMMANDS.has(sub) ? rest.shift() : undefined;
	if (ID_SUBCOMMANDS.has(sub) && !target) throw new Error(`notes ${sub} needs a note id.`);
	const run = createRun(scopeOptions({ ...options, positional: rest }));
	const { db, scopeKey, scope } = run;
	const say = (value) => process.stdout.write(typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`);

	if (sub === 'list') {
		const notes = listNotes(db, { scopeKey, status: options.status ?? 'all' });
		if (options.format && options.format !== 'table') return say(exportNotes(notes, options.format, { title: scope.prTitle }));
		if (options.json) return say(notes);
		if (!notes.length) return say('No notes for this diff.');
		for (const note of notes) {
			say(`${note.id.slice(0, 8)}  ${note.status.padEnd(8)} ${note.path}:${note.start_line}${note.end_line > note.start_line ? `-${note.end_line}` : ''}\n          ${note.body.replace(/\n/g, '\n          ')}`);
		}
		return undefined;
	}
	if (sub === 'show') return say(getNote(db, resolveNoteId(db, target)));
	if (sub === 'create') {
		if (!options.file || !options.line || !options.body) throw new Error('create needs --file, --line and --body.');
		return say(createNote(db, {
			scopeKey, path: options.file, side: options.side === 'deletions' ? 'deletions' : 'additions',
			startLine: Number(options.line), endLine: Number(options.endLine ?? options.line), body: options.body,
		}));
	}
	if (sub === 'reply') {
		if (!options.body) throw new Error('reply needs --body.');
		return say(addReply(db, resolveNoteId(db, target), options.author === 'user' ? 'user' : 'agent', options.body));
	}
	if (sub === 'resolve' || sub === 'reopen') {
		const id = resolveNoteId(db, target);
		if (options.body) addReply(db, id, options.author === 'user' ? 'user' : 'agent', options.body);
		return say(updateNote(db, id, { status: sub === 'resolve' ? 'resolved' : 'open' }));
	}
	if (sub === 'delete') {
		deleteNote(db, resolveNoteId(db, target));
		return say('deleted');
	}
	if (sub === 'export') {
		const notes = listNotes(db, { scopeKey, status: options.status ?? 'open' });
		const text = exportNotes(notes, options.format ?? 'md', { title: scope.prTitle ?? scope.headRef });
		if (options.out) { writeFileSync(options.out, text); return say(`wrote ${notes.length} note(s) to ${options.out}`); }
		return say(text);
	}
	if (sub === 'post') {
		const result = postToGitHub(db, scope, {
			notes: listNotes(db, { scopeKey, status: 'open' }),
			summary: options.summary ?? '',
			dryRun: Boolean(options.dryRun),
		});
		return say(result);
	}
	throw new Error(`Unknown notes command "${sub}". Run unfold --help.`);
}

export async function runCli(argv) {
	const options = parseArgs(argv);
	if (options.help || options.h || argv[0] === 'help') { process.stdout.write(USAGE); return; }

	const command = options.positional[0];
	if (command === 'tree') { options.positional.shift(); commandTree(options); return; }
	if (command === 'path' || command === 'blocks') { options.positional.shift(); commandTree(options, { reviewBlocks: true }); return; }
	if (command === 'review') { options.positional.shift(); await commandReview(options); return; }
	if (command === 'notes') { options.positional.shift(); await commandNotes(options); return; }
	if (command === 'show') options.positional.shift();
	await commandShow(options);
}
