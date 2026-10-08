const token = window.UNFOLD_TOKEN;

const state = {
	scope: null,
	tree: null,
	trees: { path: null, files: null },
	view: 'path',
	stepOrder: [],
	totalSteps: 0,
	totalBlocks: 0,
	rootPayload: null,
	byId: new Map(),
	expanded: new Set(),
	selectedId: null,
	explanations: {},
	notes: [],
	showHunks: false,
	filter: '',
	detail: null,
	selection: null,
	agent: { name: 'codex', model: null },
	cost: { totalUsd: 0, calls: 0 },
	busy: new Set(),
	asking: new Set(),
	questions: {},
	visited: new Set(),
	trace: null,
	traceHistory: [],
	brief: { status: 'idle', body: '', generated: false, linearIssues: [], warning: null },
	reviewPlan: { status: 'idle', chunks: [], generated: false, warning: null },
	planByBlock: new Map(),
	prReview: { status: 'idle' },
};

const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
	const response = await fetch(`/api${path}`, {
		...options,
		headers: { 'x-unfold-token': token, 'content-type': 'application/json', ...(options.headers ?? {}) },
	});
	const text = await response.text();
	const data = text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text;
	if (!response.ok) throw new Error(data?.error ?? `HTTP ${response.status}`);
	return data;
}

let toastTimer = null;
function toast(message, ms = 3600) {
	const element = $('toast');
	element.textContent = message;
	element.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { element.hidden = true; }, ms);
}

/* ---------- tiny markdown ---------- */

/** Quotes included: this output is spliced into HTML attributes, not just text. */
function escapeHtml(text) {
	return String(text)
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A diff, and anything written about one, is untrusted input. */
function safeHref(url) {
	return /^(https?:|mailto:)/i.test(url.trim()) ? url : null;
}

function inline(text) {
	return escapeHtml(text)
		.replace(/`([^`]+)`/g, '<code>$1</code>')
		.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<em>$2</em>')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, label, url) => {
			const href = safeHref(url);
			return href ? `<a href="${href}" target="_blank" rel="noreferrer noopener">${label}</a>` : match;
		})
		.replace(/\[unverified[^\]]*\]/gi, (match) => `<span class="unverified">${match}</span>`);
}

function markdown(text) {
	const out = [];
	let fence = null;
	let list = null;
	const closeList = () => { if (list) { out.push('</ul>'); list = null; } };

	for (const raw of String(text ?? '').split('\n')) {
		if (/^\s*```/.test(raw)) {
			if (fence === null) { closeList(); fence = []; } else { out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`); fence = null; }
			continue;
		}
		if (fence !== null) { fence.push(raw); continue; }
		const bullet = raw.match(/^\s*[-*]\s+(.*)$/);
		if (bullet) {
			if (!list) { out.push('<ul>'); list = true; }
			out.push(`<li>${inline(bullet[1])}</li>`);
			continue;
		}
		closeList();
		if (!raw.trim()) continue;
		const heading = raw.match(/^(#{1,6})\s+(.*)$/);
		const location = raw.match(/^Location:\s+(.+):(\d+)(?:-(\d+))?\s*$/i);
		const finding = raw.match(/^\*\*Review (?:risk|finding)\s*[·:—-]\s*(LOW|MEDIUM|HIGH|CRITICAL)(?:\s*[·:—-]\s*[A-Z]+)?\*\*/i);
		out.push(location
			? `<button class="review-location" data-open-path="${escapeHtml(location[1])}" data-open-line="${location[2]}">Location · ${escapeHtml(location[1])}:${location[2]}${location[3] ? `–${location[3]}` : ''} →</button>`
			: heading
			? `<p><strong>${inline(heading[2])}</strong></p>`
			: `<p${finding ? ` class="review-risk risk-${finding[1].toLowerCase()}"` : ''}>${inline(raw)}</p>`);
	}
	if (fence !== null) out.push(`<pre>${escapeHtml(fence.join('\n'))}</pre>`);
	closeList();
	return out.join('\n');
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const counts = (node) => (node.added || node.removed
	? `<span class="add">+${node.added}</span> <span class="del">−${node.removed}</span>`
	: '');

/* ---------- tree ---------- */

function indexTree(node, parent = null) {
	node.parent = parent;
	state.byId.set(node.id, node);
	node.children.forEach((child) => indexTree(child, node));
}

function matchesFilter(node) {
	if (!state.filter) return true;
	const needle = state.filter.toLowerCase();
	if (node.label.toLowerCase().includes(needle)) return true;
	if (node.path?.toLowerCase().includes(needle)) return true;
	return node.children.some(matchesFilter);
}

function visibleRows(node, depth = 0, rows = []) {
	if (!state.showHunks && node.kind === 'hunk') return rows;
	if (!matchesFilter(node)) return rows;
	rows.push({ node, depth });
	const open = state.expanded.has(node.id) || (state.filter && node.children.some(matchesFilter));
	if (open) node.children.forEach((child) => visibleRows(child, depth + 1, rows));
	return rows;
}

/** A file's last two path segments read as well as the whole path and fit the column. */
function treeLabel(node) {
	if (node.kind !== 'file') return escapeHtml(truncate(node.label, 60));
	const segments = node.label.split('/');
	const name = segments.pop();
	const parent = segments.pop();
	return (parent ? `<span class="dir">${escapeHtml(parent)}/</span>` : '') + escapeHtml(name);
}

const BLOCK_NUMBER = new Map();

function blockTypeLabel(type) {
	if (type === 'bug') return 'Bug fix';
	if (type === 'feature') return 'Feature';
	if (type === 'change') return 'Change';
	return 'Appendix';
}

/** No kind badges: indentation carries the hierarchy and the label carries the name. */
function rowHtml({ node, depth }) {
	const children = state.showHunks ? node.children : node.children.filter((child) => child.kind !== 'hunk');
	const open = state.expanded.has(node.id);
	const classes = [
		'node-row',
		node.id === state.selectedId ? 'selected' : '',
		node.excluded ? 'excluded' : '',
		node.kind === 'root' ? 'is-root' : '',
		node.kind === 'block' ? 'is-block' : '',
		node.kind === 'block' && node.appendix ? 'is-tests' : '',
		state.visited.has(node.id) ? 'visited' : '',
		node.kind === 'file' || node.kind === 'group' ? 'is-path' : '',
		node.endpoint ? 'is-endpoint' : '',
	].filter(Boolean).join(' ');
	const plan = node.kind === 'block' ? state.planByBlock.get(node.id) : null;
	const label = plan ? escapeHtml(plan.title) : treeLabel(node);
	const blockLabel = node.kind === 'block'
		? `<span class="block-row-copy">
			<span class="block-row-title">${label}</span>
			<span class="block-row-meta"><span class="block-kind kind-${escapeHtml(node.blockType ?? 'appendix')}">${blockTypeLabel(node.blockType)}</span>${node.appendix ? '' : ` · Block ${BLOCK_NUMBER.get(node.id) ?? ''}`}${node.sharedCount ? ` · ${node.sharedCount} shared` : ''}</span>
		</span>`
		: `${label}${node.shared && node.kind !== 'hunk' ? ' <span class="shared-unit">shared</span>' : ''}`;
	const title = plan ? `${plan.title} — ${node.label}` : node.path ?? node.label;
	return `<li>
		<div class="${classes}" data-id="${node.id}" style="padding-left:${8 + depth * 12}px" role="treeitem" title="${escapeHtml(title)}">
			<span class="twisty ${children.length ? '' : 'leaf'}" data-twisty="${node.id}">${children.length ? (open ? '▼' : '▶') : ''}</span>
			<span class="mark ${state.explanations[node.key] ? 'explained' : ''}"></span>
			<span class="label">${blockLabel}</span>
			<span class="n">${counts(node)}</span>
		</div>
	</li>`;
}

function renderProgress() {
	const blocks = state.rootPayload?.reviewBlocks ?? [];
	const visited = blocks.filter((block) => state.visited.has(block.id)).length;
	$('progress-label').textContent = `${visited} / ${state.totalBlocks}`;
	$('progress-fill').style.width = `${state.totalBlocks ? (visited / state.totalBlocks) * 100 : 0}%`;
}

/** Hard ceiling on rendered rows. Expanding a 10k-node tree is otherwise 90k DOM nodes. */
const MAX_ROWS = 3000;

function renderTree() {
	const rows = visibleRows(state.tree);
	const shown = rows.slice(0, MAX_ROWS);
	const overflow = rows.length - shown.length;
	$('tree').innerHTML = shown.map(rowHtml).join('')
		+ (overflow > 0 ? `<li><div class="overflow-row">${overflow} more — filter or collapse</div></li>` : '');
}

function toggle(id, force) {
	if (force === true) state.expanded.add(id);
	else if (force === false) state.expanded.delete(id);
	else if (state.expanded.has(id)) state.expanded.delete(id);
	else state.expanded.add(id);
	renderTree();
}

function expandTo(node) {
	let current = node.parent;
	while (current) { state.expanded.add(current.id); current = current.parent; }
}

function expandAll(node = state.tree) {
	if (node.children.length) state.expanded.add(node.id);
	node.children.forEach((child) => { if (child.kind !== 'hunk') expandAll(child); });
}

/* ---------- shared helpers ---------- */

const lineKey = (path, side, n) => `${path}|${side}|${n}`;

function notedLines() {
	const set = new Set();
	for (const note of state.notes) {
		if (note.status !== 'open') continue;
		for (let n = note.start_line; n <= note.end_line; n++) set.add(lineKey(note.path, note.side, n));
	}
	return set;
}

/** Notes anchored inside whatever is on screen, so they read next to the prose. */
function notesHere(data) {
	const path = data.node.payload?.path;
	if (!path) return [];
	const start = data.node.payload?.start ?? data.node.payload?.from;
	const end = data.node.payload?.end ?? data.node.payload?.to;
	return state.notes.filter((note) => {
		if (note.path !== path) return false;
		if (data.node.kind === 'file' || start == null) return true;
		return note.end_line >= start && note.start_line <= end;
	});
}

function stepNeighbours() {
	if (state.view !== 'path' || !state.stepOrder.length) return { previous: null, next: null };
	const at = state.stepOrder.indexOf(state.selectedId);
	return {
		previous: at > 0 ? state.stepOrder[at - 1] : null,
		next: at >= 0 && at < state.stepOrder.length - 1 ? state.stepOrder[at + 1] : null,
	};
}

function containingBlock(node) {
	let current = state.byId.get(node?.id) ?? node;
	while (current && current.kind !== 'block') current = current.parent;
	return current?.appendix ? null : current;
}

function reviewPosition(node) {
	const blocks = (state.rootPayload?.reviewBlocks ?? []).map((block) => state.byId.get(block.id)).filter(Boolean);
	const block = containingBlock(node);
	if (!block) return null;
	const blockIndex = blocks.findIndex((candidate) => candidate.id === block.id);
	if (blockIndex < 0) return null;
	if (node.kind === 'block') {
		return {
			label: `${blockTypeLabel(block.blockType)} · Block ${blockIndex + 1} of ${blocks.length}`,
			previous: blocks[blockIndex - 1]?.id ?? null,
			next: blocks[blockIndex + 1]?.id ?? null,
			previousLabel: 'Previous block', nextLabel: 'Next block',
			block,
		};
	}
	const local = state.stepOrder
		.map((id) => state.byId.get(id))
		.filter((candidate) => candidate && candidate.kind !== 'block' && containingBlock(candidate)?.id === block.id);
	const partIndex = local.findIndex((candidate) => candidate.id === node.id);
	const hasPreviousPart = partIndex > 0;
	const hasNextPart = partIndex >= 0 && partIndex < local.length - 1;
	return {
		label: `Code step ${Math.max(0, partIndex) + 1} of ${local.length} · Block ${blockIndex + 1} of ${blocks.length}`,
		previous: hasPreviousPart ? local[partIndex - 1].id : block.id,
		next: hasNextPart ? local[partIndex + 1].id : blocks[blockIndex + 1]?.id ?? null,
		previousLabel: hasPreviousPart ? 'Previous code step' : 'Block overview',
		nextLabel: hasNextPart ? 'Next code step' : 'Next block',
		block,
	};
}

function factsPanelHtml(facts) {
	if (!facts) return '';
	const row = (term, value) => `<div class="fact"><span class="term">${term}</span><span class="value">${value}</span></div>`;
	const rows = [
		row('route', `<code>${escapeHtml(facts.verb)} ${escapeHtml(facts.route)}</code>`),
		row('auth', escapeHtml(facts.auth)),
		row('scope', facts.scope ? `<code>${escapeHtml(facts.scope)}</code>` : '<span class="none">none</span>'),
		facts.licence ? row('licence', `<code>${escapeHtml(facts.licence)}</code>`) : '',
		row('rate limit', facts.limit ? `<code>${escapeHtml(facts.limit)}</code>` : '<span class="none">none</span>'),
		row('validates', facts.validates?.length
			? facts.validates.map((name) => `<code>${escapeHtml(name)}</code>`).join(' ')
			: '<span class="none">nothing declared</span>'),
		facts.flags?.length ? row('flags', `<code>${escapeHtml(facts.flags.join(', '))}</code>`) : '',
	].filter(Boolean).join('');
	return `<div class="group"><span class="eyebrow">Read from the decorators</span><div class="facts">${rows}</div></div>`;
}

/** The overview answers "what can be triggered" before any model call happens. */
function overviewHtml() {
	const payload = state.rootPayload ?? {};
	const endpoints = payload.entryPoints ?? [];
	const blocks = (state.trees.path?.children ?? []).filter((child) => child.kind === 'block' && !child.appendix);
	const firstPending = blocks.find((block) => !state.visited.has(block.id))?.id;
	const usefulBlurb = (block) => {
		const blurb = block.blurb?.trim();
		if (!blurb || blurb === state.scope?.prTitle || /^https?:\/\//.test(blurb)) return '';
		return ` · ${escapeHtml(truncate(blurb, 72))}`;
	};
	const step = (block, index) => {
		const plan = state.planByBlock.get(block.id);
		const risk = plan?.risk && plan.risk !== 'none'
			? `<span class="risk-pill risk-${escapeHtml(plan.risk)}">${escapeHtml(plan.risk)} risk</span>`
			: '';
		return `<button class="journey-step" data-goto="${block.id}">
			<span class="journey-number">${index + 1}</span>
			<span class="journey-copy"><b>${escapeHtml(plan?.title ?? block.label)}</b><small><span class="block-kind kind-${escapeHtml(block.blockType)}">${blockTypeLabel(block.blockType)}</span> · ${block.children.length} code unit${block.children.length === 1 ? '' : 's'}${block.sharedCount ? ` · ${block.sharedCount} shared` : ''}${plan ? '' : usefulBlurb(block)} ${risk}</small>${plan ? `<span class="journey-description">${escapeHtml(plan.description)}</span><span class="journey-analysis">${escapeHtml(plan.analysis)}</span>` : ''}</span>
			<span class="journey-state">${state.visited.has(block.id) ? 'Reviewed' : block.id === firstPending ? 'Start →' : 'Open →'}</span>
		</button>`;
	};
	const initialCount = 10;
	const blockList = blocks.slice(0, initialCount).map(step).join('');
	const remaining = blocks.slice(initialCount);
	const more = remaining.length ? `<details class="journey-more"><summary>Show ${remaining.length} more review block${remaining.length === 1 ? '' : 's'}</summary><div class="journey">${remaining.map((block, offset) => step(block, initialCount + offset)).join('')}</div></details>` : '';
	const typeCount = (type) => blocks.filter((block) => block.blockType === type).length;
	const planStatus = state.reviewPlan.status === 'loading'
		? '<div class="plan-status"><span class="spin">◴</span><div><b>Mapping the execution flow…</b><span>AI is scanning every changed chunk, its callers, and its downstream effects.</span></div></div>'
		: state.reviewPlan.warning
			? `<div class="plan-status warning"><div><b>Using the code-derived order</b><span>${escapeHtml(state.reviewPlan.warning)}</span></div></div>`
			: '';
	const summary = `<div class="review-plan-summary"><div><strong>${blocks.length} ${state.reviewPlan.generated ? 'AI-ordered chunks' : 'focused reviews'}</strong><p>${state.reviewPlan.generated ? 'Ordered from inputs and contracts through runtime behavior to user-visible output.' : 'Work top-down. Shared code is repeated where its behavior must be assessed in more than one flow.'}</p></div><div class="review-counts">${typeCount('feature') ? `<span>${typeCount('feature')} features</span>` : ''}${typeCount('bug') ? `<span class="bug">${typeCount('bug')} bug fixes</span>` : ''}${typeCount('change') ? `<span>${typeCount('change')} supporting changes</span>` : ''}</div></div>`;
	const endpointList = endpoints.length
		? endpoints.map((entry) => `<div class="endpoint">
				<div class="route"><span class="verb ${entry.verb.toLowerCase()}">${entry.verb}</span> <code>${escapeHtml(entry.route)}</code></div>
				<div class="guards">${escapeHtml(entry.scope ?? 'no scope')}${entry.licence ? ` · ${escapeHtml(entry.licence)}` : ''}${entry.limit ? ' · rate limited' : ''} · ${escapeHtml(entry.auth)}</div>
			</div>`).join('')
		: '';
	return `
		${endpointList ? `<div class="group"><span class="eyebrow">Changed entry points</span>${endpointList}</div>` : ''}
		<div class="group review-plan"><span class="eyebrow">Review plan</span>${planStatus}${summary}<div class="journey">${blockList}</div>${more}</div>`;
}

function intentBriefHtml() {
	const brief = state.brief;
	const tickets = brief.linearIssues ?? [];
	const sources = tickets.length ? `<div class="intent-sources"><span>Product context</span>${tickets.map((issue) => {
		const href = safeHref(issue.url ?? '');
		const title = issue.title ? `${issue.identifier} · ${issue.title}` : issue.identifier;
		return href
			? `<a href="${escapeHtml(href)}" target="_blank" rel="noreferrer noopener" class="intent-source ${issue.resolved ? 'resolved' : ''}">${escapeHtml(title)}${issue.state ? `<small>${escapeHtml(issue.state)}</small>` : ''}</a>`
			: `<span class="intent-source">${escapeHtml(title)}</span>`;
	}).join('')}</div>` : '';
	const body = brief.status === 'loading'
		? '<div class="brief-loading"><i></i><i></i><i></i></div>'
		: `<div class="intent-copy">${markdown(brief.body || 'Reading the PR description…')}</div>`;
	return `<section class="intent-brief">
		<div class="intent-label"><span class="eyebrow">What this PR is trying to accomplish</span>${brief.generated ? `<span class="source-note">${tickets.length ? 'PR description + linked context' : 'PR description'}</span>` : ''}</div>
		${body}${sources}
		${brief.warning ? `<div class="intent-warning">${escapeHtml(brief.warning)}</div>` : ''}
	</section>`;
}

function testAppendixHtml() {
	const tests = (state.trees.path?.children ?? []).find((block) => block.blockType === 'tests');
	if (!tests) return '';
	return `<div class="test-appendix"><div><span class="eyebrow">Optional appendix</span><b>Tests</b><p>${tests.children.length} test item${tests.children.length === 1 ? '' : 's'}, kept outside the main review path.</p></div><button class="btn" data-goto="${tests.id}">Open tests</button></div>`;
}

function prReviewHtml() {
	const review = state.prReview ?? { status: 'idle' };
	const resume = review.threadId ? `codex exec resume ${review.threadId} "Follow up on the PR review."` : '';
	const controls = review.status === 'running'
		? '<button class="btn" disabled>Review running…</button>'
		: `<button class="btn primary" id="review-run">${review.status === 'complete' ? 'Run again' : 'Run PR review'}</button><button class="btn" id="review-deep">Force deep review</button>`;
	const status = review.status === 'running'
		? `<div class="agent-review-status running"><span class="spin">◴</span><div><b>${escapeHtml(review.activity ?? 'Reviewing the PR…')}</b><span>Codex is independently checking the repository and each Unfold chunk.</span></div></div>`
		: review.status === 'failed'
			? `<div class="agent-review-status failed"><div><b>Review stopped</b><span>${escapeHtml(review.error ?? 'Codex did not complete the review.')}</span></div></div>`
			: '';
	const output = review.status === 'complete' && review.body
		? `<details class="agent-review-output" open><summary>Verified review findings</summary><div class="prose">${markdown(review.body)}</div></details>`
		: '';
	return `<section class="agent-review" id="agent-review">
		<div class="agent-review-head"><div><span class="eyebrow">Independent review</span><h2>Codex + Unfold chunks</h2><p>The <code>pr-review</code> skill verifies the PR independently, then uses this execution-ordered map to make sure every change is inspected.</p></div><div class="actions">${controls}</div></div>
		<div class="agent-capabilities"><span>Repository-aware session</span><span>git + shell</span><span>configured MCPs</span><span>workspace approvals</span></div>
		${status}${output}
		${review.threadId ? `<div class="agent-session"><span>Persistent Codex session · ${escapeHtml(review.threadId)}</span><button class="link" id="review-copy-resume" data-resume="${escapeHtml(resume)}">copy resume command</button></div>` : ''}
	</section>`;
}

function chunkReviewFindingsHtml(data) {
	if (data.node.kind !== 'block' || state.prReview?.status !== 'complete' || !state.prReview.body) return '';
	const id = data.node.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	const findingSections = String(state.prReview.body)
		.split(/(?=\*\*Review (?:finding|risk)\s*[·:—-])/i)
		.filter((part) => new RegExp(`\\b${id}\\b`).test(part));
	if (!findingSections.length) return '';
	return `<section class="chunk-review-findings"><span class="eyebrow">Codex review findings for this chunk</span><div class="prose">${markdown(findingSections.join('\n\n'))}</div></section>`;
}

/* ---------- narrative pane ---------- */

function crumbHtml(breadcrumb) {
	if (!breadcrumb.length) return '';
	const tail = breadcrumb.slice(-2);
	const parts = tail.map((crumb) => {
		const label = crumb.kind === 'file' ? crumb.label.split('/').pop() : crumb.label;
		return `<button data-goto="${crumb.id}">${escapeHtml(truncate(label, 22))}</button>`;
	});
	const prefix = breadcrumb.length > tail.length
		? `<button data-goto="${breadcrumb[0].id}">top</button><span class="slash">/</span><span class="slash">…</span>`
		: '';
	return `<div class="crumb">${prefix}${parts.join('<span class="slash">/</span>')}</div>`;
}

function explanationHtml(data) {
	if (state.busy.has(data.node.id)) {
		return '<div class="placeholder"><span class="spin">◴</span> Explaining…</div>';
	}
	const body = data.explanations.deep ?? data.explanations.shallow;
	if (body) return `<div class="prose">${markdown(body)}</div>`;
	const hasChildren = data.children.some((child) => child.kind !== 'hunk');
	const block = data.node.kind === 'block';
	return `<div class="placeholder">${data.node.kind === 'root'
		? 'Generate an implementation overview when you are ready, or assess every review block for a complete pass.'
		: block
		? 'Start with a concise explanation of this change, or review the whole block to connect every affected code unit.'
		: `Explain this code in place${hasChildren ? ', or include everything nested beneath it' : ''}.`}</div>`;
}

function composeHtml() {
	if (!state.selection) return '';
	const { path, side, start, end } = state.selection;
	return `<div class="group"><span class="eyebrow">New note</span>
		<div class="compose">
			<div class="anchor">${escapeHtml(path.split('/').pop())} · ${side === 'deletions' ? 'old' : 'new'} L${start}${end > start ? `–${end}` : ''}</div>
			<textarea id="note-body" placeholder="What should change, or what do you want to ask?"></textarea>
			<div class="row">
				<button class="btn primary" id="note-save">Save</button>
				<button class="btn" id="note-cancel">Cancel</button>
			</div>
		</div></div>`;
}

function noteCardHtml(note, { compact = false } = {}) {
	return `<div class="note-card ${note.status}">
		<div class="anchor" data-note-goto="${note.id}">${escapeHtml(compact ? note.path.split('/').pop() : note.path)} L${note.start_line}${note.end_line > note.start_line ? `–${note.end_line}` : ''}</div>
		<div class="text">${escapeHtml(note.body)}</div>
		${note.code && !compact ? `<pre>${escapeHtml(note.code)}</pre>` : ''}
		${(note.replies ?? []).map((reply) => `<div class="reply"><b>${escapeHtml(reply.author)}</b><br>${escapeHtml(reply.body)}</div>`).join('')}
		<div class="row">
			<button class="link" data-note-toggle="${note.id}">${note.status === 'open' ? 'resolve' : 'reopen'}</button>
			<button class="link" data-note-delete="${note.id}">delete</button>
			${note.posted_url ? `<a class="link" href="${note.posted_url}" target="_blank" rel="noreferrer">on GitHub</a>` : ''}
		</div>
	</div>`;
}

function contextHtml(context) {
	if (!context) return '';
	const hit = (item) => `<button class="hit trace-link" data-open-path="${escapeHtml(item.path)}" data-open-line="${item.line}"><span class="where">${escapeHtml(item.path)}:${item.line}</span> ${escapeHtml(truncate(item.text ?? '', 90))}</button>`;
	const cards = [];
	const resolved = (context.dependencies ?? []).filter((dep) => dep.resolved);

	if (resolved.length) {
		cards.push(['Imports it relies on', resolved.length, resolved.map((dep) =>
			`<button class="hit trace-link" data-resolve-name="${escapeHtml(dep.local)}" data-resolve-from="${escapeHtml(state.detail.node.payload.path)}"><code>${escapeHtml(dep.local)}</code> → <span class="where">${escapeHtml(dep.resolved)}${dep.declaration ? `:${dep.declaration.line}` : ''}</span></button>`).join('')]);
	}
	if (context.callers?.length) {
		cards.push([`Used by, in ${escapeHtml(context.searchedIn ?? '')}`, context.callers.length, context.callers.map(hit).join('')]);
	}
	if (context.sameFile?.length) {
		cards.push(['Used in this file', context.sameFile.length, context.sameFile.map((item) =>
			`<button class="hit trace-link" data-open-path="${escapeHtml(state.detail.node.payload.path)}" data-open-line="${item.line}"><span class="where">L${item.line}</span> ${escapeHtml(truncate(item.text, 90))}</button>`).join('')]);
	}
	if (context.localReferences?.length) {
		cards.push(['Declared alongside it', context.localReferences.length, context.localReferences.map((ref) =>
			`<button class="hit trace-link" data-open-path="${escapeHtml(state.detail.node.payload.path)}" data-open-line="${ref.start}">${escapeHtml(ref.kind)} <code>${escapeHtml(ref.name)}</code> <span class="where">L${ref.start}</span></button>`).join('')]);
	}
	if (context.tests?.length) {
		cards.push(['Tests that name it', context.tests.length, context.tests.map(hit).join('')]);
	}
	if (context.importers?.length) {
		cards.push(['Files importing this one', context.importers.length, context.importers.map(hit).join('')]);
	}
	if (!cards.length) return '';
	return `<div class="group"><span class="eyebrow">Follow the evidence</span>${cards.map(([title, count, body]) =>
		`<details class="card"><summary>${title} <span class="n">${count}</span></summary><div class="card-body">${body}</div></details>`).join('')}</div>`;
}

const MAX_JUMPS = 24;

function childrenHtml(children, parent) {
	const worth = children.filter((child) => child.kind !== 'hunk');
	if (!worth.length) return '';
	const shown = worth.slice(0, MAX_JUMPS);
	const heading = parent.kind === 'block' ? 'Code in this block' : 'Unfold into';
	return `<div class="group"><span class="eyebrow">${heading}</span>
		${shown.map((child) => `<button class="jump" data-goto="${child.id}">
			<span class="mark ${child.explained ? 'explained' : ''}"></span>
			<span class="${child.kind === 'file' ? 'mono' : ''}">${escapeHtml(truncate(child.label === '(module scope)' ? 'Top-level setup' : child.label, 44))}</span>
			<span class="n">${counts(child)}</span>
		</button>`).join('')}
		${worth.length > shown.length ? `<div class="hit">+${worth.length - shown.length} more in the tree</div>` : ''}</div>`;
}

function traceMapHtml(data) {
	if (data.node.kind !== 'symbol' || !data.context) return '';
	const dependencies = (data.context.dependencies ?? []).filter((item) => item.resolved).slice(0, 3);
	const consumers = (data.context.callers ?? []).slice(0, 3);
	if (!dependencies.length && !consumers.length) return '';
	const nodes = (items, direction) => items.length
		? items.map((item) => {
			const path = item.resolved ?? item.path;
			const line = item.declaration?.line ?? item.line ?? 1;
			const label = item.local ?? path.split('/').pop();
			const resolve = item.local
				? `data-resolve-name="${escapeHtml(item.local)}" data-resolve-from="${escapeHtml(data.node.payload.path)}"`
				: `data-open-path="${escapeHtml(path)}" data-open-line="${line}"`;
			return `<button class="trace-node" ${resolve}><b>${escapeHtml(label)}</b><small>${escapeHtml(path.split('/').slice(-2).join('/'))}</small></button>`;
		}).join('')
		: `<span class="trace-empty">${direction === 'in' ? 'no changed dependency' : 'no caller found'}</span>`;
	return `<div class="group"><span class="eyebrow">Trace map</span><div class="trace-map">
		<div class="trace-column"><span class="trace-label">relies on</span>${nodes(dependencies, 'in')}</div>
		<span class="trace-arrow">→</span>
		<div class="trace-current"><small>${escapeHtml(data.node.payload.symbolKind ?? 'symbol')}</small><b>${escapeHtml(data.node.label)}</b></div>
		<span class="trace-arrow">→</span>
		<div class="trace-column"><span class="trace-label">used by</span>${nodes(consumers, 'out')}</div>
	</div></div>`;
}

function questionsHtml(data) {
	const thread = state.questions[data.node.key] ?? [];
	const busy = state.asking.has(data.node.id);
	const block = data.node.kind === 'block';
	const root = data.node.kind === 'root';
	const scopeLabel = state.planByBlock.get(data.node.id)?.title ?? data.node.label;
	return `<div class="group ask-panel">
		<div class="ask-heading"><div><span class="eyebrow">${root ? 'Ask about this PR' : block ? 'Ask about this change' : 'Ask about this code'}</span><p>${root ? 'Question the goal, scope, or overall implementation.' : block ? 'Question the purpose, boundaries, or behavior of this review block.' : 'Question the code in the context you are currently reading.'}</p></div><span class="scope-chip">${escapeHtml(scopeLabel)}</span></div>
		${thread.length ? `<div class="conversation">${thread.map((entry) => `<div class="message ${entry.role}"><span>${entry.role === 'user' ? 'You' : 'Unfold'}</span><div>${entry.role === 'assistant' ? markdown(entry.body) : escapeHtml(entry.body)}</div></div>`).join('')}</div>` : ''}
		<div class="ask-compose">
			<textarea id="question-body" placeholder="Why is this needed? What calls it? What happens when it fails?" ${busy ? 'disabled' : ''}></textarea>
			<button class="btn primary" id="question-send" ${busy ? 'disabled' : ''}>${busy ? 'Answering…' : 'Ask'}</button>
		</div>
		<div class="ask-foot">${root ? 'Grounded in the PR description, linked context, and complete diff.' : block ? 'Grounded in this block and every code unit it contains.' : 'Grounded in this symbol, its dependencies, and callers.'}</div>
	</div>`;
}

function chunkBriefHtml(data) {
	if (data.node.kind !== 'block') return '';
	const plan = state.planByBlock.get(data.node.id);
	if (!plan) {
		return state.reviewPlan.status === 'loading'
			? '<section class="chunk-brief loading"><span class="spin">◴</span> AI is reading this chunk and placing it in the execution flow…</section>'
			: '';
	}
	const risk = plan.risk !== 'none'
		? `<div class="chunk-risk risk-${escapeHtml(plan.risk)}"><b>${escapeHtml(plan.risk)} risk</b>${plan.riskReason ? `<span>${escapeHtml(plan.riskReason)}</span>` : ''}</div>`
		: '';
	return `<section class="chunk-brief">
		<div><span class="eyebrow">What changes</span><p>${escapeHtml(plan.description)}</p></div>
		<div><span class="eyebrow">Why it comes here</span><p>${escapeHtml(plan.analysis)}</p></div>
		${risk}
	</section>`;
}

function renderNarrative() {
	const data = state.detail;
	const here = notesHere(data);
	const payload = data.node.payload ?? {};
	const isEndpoint = Boolean(payload.facts);
	const isMono = !isEndpoint && (data.node.kind === 'file' || data.node.kind === 'group');
	const label = state.planByBlock.get(data.node.id)?.title
		?? (data.node.kind === 'file' ? data.node.label.split('/').pop() : data.node.label);
	const hasChildren = data.children.some((child) => child.kind !== 'hunk');
	const review = reviewPosition(data.node);
	const stepLinks = stepNeighbours();
	const previous = review ? review.previous : stepLinks.previous;
	const next = review ? review.next : stepLinks.next;
	const previousLabel = review?.previousLabel ?? 'Previous code step';
	const nextLabel = review?.nextLabel ?? 'Next code step';
	const parts = [
		isEndpoint ? null : payload.symbolKind,
		payload.status,
		payload.exported ? 'exported' : null,
		payload.shared ? 'shared across review blocks' : null,
		payload.path && data.node.kind !== 'file' ? payload.path.split('/').pop() : null,
		data.node.hunkCount ? `${data.node.hunkCount} change group${data.node.hunkCount > 1 ? 's' : ''}` : null,
	].filter(Boolean);
	const root = data.node.kind === 'root';
	const repeatedBlurb = payload.blurb?.trim() === state.scope?.prTitle?.trim();
	const actions = `<div class="actions">
		<button class="btn primary" id="explain-one">${data.explanations.shallow ? 'Re-explain' : (root ? 'Analyze the implementation' : data.node.kind === 'block' ? 'Explain this change' : 'Explain this code')}</button>
		${hasChildren ? `<button class="btn" id="explain-deep">${data.explanations.deep ? (root ? 'Redo all blocks' : 'Redo block') : (root ? 'Assess all review blocks' : data.node.kind === 'block' ? 'Review this block' : 'Explain with nested code')}</button>` : ''}
	</div>`;

	$('narrative').innerHTML = `
		${crumbHtml(data.breadcrumb)}
		${review ? `<div class="step review-step kind-${escapeHtml(review.block.blockType)}">${escapeHtml(review.label)}</div>` : ''}
		<h1 class="title ${isMono ? 'mono' : ''} ${isEndpoint ? 'route' : ''}">${escapeHtml(label)}</h1>
		<div class="sub">${counts(data.node)}${parts.length ? ` · ${escapeHtml(parts.join(' · '))}` : ''}${payload.blurb && !repeatedBlurb ? ` — ${escapeHtml(payload.blurb)}` : ''}</div>
		${root ? intentBriefHtml() : `${chunkBriefHtml(data)}${chunkReviewFindingsHtml(data)}`}
		${root ? overviewHtml() : factsPanelHtml(payload.facts)}
		${root ? prReviewHtml() : ''}
		${root ? `<div class="implementation-overview"><span class="eyebrow">Implementation overview</span>${actions}<div>${explanationHtml(data)}</div></div>` : `${actions}<div class="group">${explanationHtml(data)}</div>`}
		${traceMapHtml(data)}
		${questionsHtml(data)}
		${root ? testAppendixHtml() : ''}
		${composeHtml()}
		${here.length ? `<div class="group"><span class="eyebrow">Notes here</span>${here.map((note) => noteCardHtml(note, { compact: true })).join('')}</div>` : ''}
		${contextHtml(data.context)}
		${root ? '' : childrenHtml(data.children, data.node)}
		${previous || next ? `<div class="pager">
			${previous ? `<button class="btn" data-goto="${previous}">← ${previousLabel}</button>` : '<span></span>'}
			${next ? `<button class="btn primary" data-goto="${next}">${nextLabel} →</button>` : '<span></span>'}
		</div>` : ''}
	`;
}

/* ---------- code pane ---------- */

function diffRowHtml(line, path, noted) {
	const side = line.t === '-' ? 'deletions' : 'additions';
	const number = line.t === '-' ? line.o : line.n;
	const classes = [
		'cl',
		line.t === '+' ? 'add' : line.t === '-' ? 'del' : '',
		noted.has(lineKey(path, side, number)) ? 'noted' : '',
		state.selection && state.selection.path === path && state.selection.side === side
			&& number >= state.selection.start && number <= state.selection.end ? 'sel' : '',
	].filter(Boolean).join(' ');
	return `<div class="${classes}" data-path="${escapeHtml(path)}" data-side="${side}" data-n="${number ?? ''}">`
		+ `<span class="gut">${number ?? ''}</span><span class="mk">${line.t === ' ' ? '' : line.t}</span><span class="src">${line.html}</span></div>`;
}

/**
 * One block per file, not one per hunk. Ten bordered cards with repeated headers
 * read as ten things; a single block with gap markers reads as one file.
 */
function changedLinesHtml(hunks, noted) {
	const ordered = [...hunks].sort((a, b) => a.from - b.from);
	const parts = [];
	let previousTo = null;
	for (const hunk of ordered) {
		if (previousTo !== null && hunk.from > previousTo + 1) {
			const skipped = hunk.from - previousTo - 1;
			parts.push(`<div class="gap">⋯ ${skipped} unchanged line${skipped > 1 ? 's' : ''}</div>`);
		}
		parts.push(...hunk.lines.map((line) => diffRowHtml(line, hunk.path, noted)));
		previousTo = Math.max(previousTo ?? 0, hunk.to);
	}
	return `<div class="code"><div class="code-body">${parts.join('')}</div></div>`;
}

function changedFilesHtml(hunks, noted) {
	const files = new Map();
	for (const hunk of hunks) {
		if (!files.has(hunk.path)) files.set(hunk.path, []);
		files.get(hunk.path).push(hunk);
	}
	return [...files].map(([path, fileHunks]) => {
		const lines = fileHunks.flatMap((hunk) => hunk.lines);
		const added = lines.filter((line) => line.t === '+').length;
		const removed = lines.filter((line) => line.t === '-').length;
		return `<section class="diff-file">
			<div class="file-head"><span class="path">${escapeHtml(path)}</span><span class="meta"><span class="add">+${added}</span> <span class="del">−${removed}</span></span></div>
			${changedLinesHtml(fileHunks, noted)}
		</section>`;
	}).join('');
}

function sourceBlockHtml(source, noted) {
	const rows = source.lines.map((line) => {
		const classes = ['cl', line.changed ? 'changed' : '', noted.has(lineKey(source.path, 'additions', line.n)) ? 'noted' : ''].filter(Boolean).join(' ');
		return `<div class="${classes}" data-path="${escapeHtml(source.path)}" data-side="additions" data-n="${line.n}">`
			+ `<span class="gut">${line.n}</span><span class="mk"></span><span class="src">${line.html}</span></div>`;
	});
	const unchanged = source.lines.filter((line) => !line.changed).length;
	return `<details class="card" ${source.lines.length <= 70 ? 'open' : ''}>
		<summary>Whole region, L${source.start}–${source.end} <span class="n">${unchanged} lines the diff did not show</span></summary>
		<div class="card-body" style="padding:0"><div class="code" style="border:none;margin:0"><div class="code-body">${rows.join('')}</div></div></div>
	</details>`;
}

function tracePreviewHtml(trace) {
	const source = trace;
	const rows = source.lines.map((line) => `<div class="cl ${line.n === trace.target ? 'target' : ''}" data-path="${escapeHtml(trace.path)}" data-side="additions" data-n="${line.n}">
		<span class="gut">${line.n}</span><span class="mk"></span><span class="src" title="Click an identifier to follow it">${line.html}</span></div>`).join('');
	return `<div class="trace-preview">
		<div class="trace-preview-head">
			<div><span class="eyebrow">Following code</span><strong>${escapeHtml(trace.symbol ? `${trace.symbol.kind} ${trace.symbol.name}` : trace.path.split('/').pop())}</strong><small>${escapeHtml(trace.path)} · L${trace.target}${trace.reason ? ` · ${escapeHtml(trace.reason)}` : ''}</small></div>
			<div class="row">${state.traceHistory.length ? '<button class="btn" id="trace-back">← Back</button>' : ''}<button class="btn" id="trace-close">Back to change</button></div>
		</div>
		<div class="code"><div class="code-body">${rows}</div></div>
		<p class="trace-tip">Click an identifier to follow its definition. Resolution is deterministic and may decline when the target is ambiguous.</p>
	</div>`;
}

function renderCode() {
	const data = state.detail;
	if (state.trace) {
		document.querySelector('main').classList.remove('no-code');
		$('code').innerHTML = tracePreviewHtml(state.trace);
		requestAnimationFrame(() => $('code').querySelector('.cl.target')?.scrollIntoView({ block: 'center' }));
		return;
	}
	const noted = notedLines();
	const hasCode = Boolean(data.hunks.length || data.source);
	document.querySelector('main').classList.toggle('no-code', !hasCode);
	if (!hasCode) {
		$('code').innerHTML = '';
		return;
	}
	const path = data.node.payload?.path ?? '';
	const chunk = data.node.kind === 'block';
	$('code').innerHTML = `
		${path ? `<div class="file-head"><span class="path">${escapeHtml(path)}</span><span class="meta">${counts(data.node)}</span></div>` : ''}
		${data.hunks.length ? `<div class="group"><span class="eyebrow">${chunk ? 'Diff for this chunk' : 'Changed lines'}</span>${chunk ? changedFilesHtml(data.hunks, noted) : changedLinesHtml(data.hunks, noted)}</div>` : ''}
		${data.source ? `<div class="group"><span class="eyebrow">Code in place</span>${sourceBlockHtml(data.source, noted)}</div>` : ''}
	`;
}

function renderDetail() {
	if (!state.detail) return;
	renderNarrative();
	renderCode();
}

async function selectNode(id, { scroll = true } = {}) {
	const node = state.byId.get(id);
	if (!node) return;
	state.selectedId = id;
	state.selection = null;
	state.trace = null;
	state.traceHistory = [];
	state.visited.add(id);
	let block = node;
	while (block && block.kind !== 'block') block = block.parent;
	if (block && !block.appendix) state.visited.add(block.id);
	renderProgress();
	expandTo(node);
	renderTree();
	if (scroll) document.querySelector(`.node-row[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
	$('narrative').innerHTML = '<div class="empty"><span class="spin">◴</span> reading…</div>';
	$('code').innerHTML = '';
	try {
		state.detail = await api(`/node/${id}`);
		renderDetail();
		$('narrative').scrollTop = 0;
		$('code').scrollTop = 0;
	} catch (error) {
		$('narrative').innerHTML = `<div class="empty">Could not load: ${escapeHtml(error.message)}</div>`;
	}
}

/* ---------- explain ---------- */

function countSubtree(node) {
	if (!node) return 0;
	const worth = node.children.filter((child) =>
		child.kind !== 'hunk' && !(node.kind === 'root' && child.appendix));
	return 1 + worth.reduce((total, child) => total + countSubtree(child), 0);
}

async function explain(mode) {
	const data = state.detail;
	if (!data) return;
	const id = data.node.id;
	if (state.busy.has(id)) return;
	if (mode === 'deep') {
		const count = countSubtree(state.byId.get(id));
		if (count > 12 && !confirm(`Explain ${count} nodes bottom-up? That is ${count} model calls, roughly $${(count * 0.12).toFixed(2)}.`)) return;
	}

	state.busy.add(id);
	renderNarrative();
	try {
		const result = await api(`/explain/${id}`, {
			method: 'POST',
			body: JSON.stringify({ mode, force: Boolean(data.explanations[mode]) }),
		});
		state.explanations = result.explanations;
		state.cost = result.cost;
		state.detail.explanations[mode] = result.body;
		renderCost();
		renderTree();
	} catch (error) {
		toast(`Explain failed: ${error.message}`, 7000);
	} finally {
		state.busy.delete(id);
		renderNarrative();
	}
}

async function askQuestion() {
	const data = state.detail;
	const question = $('question-body')?.value?.trim();
	if (!data || !question || state.asking.has(data.node.id)) return;
	const thread = state.questions[data.node.key] ?? [];
	thread.push({ role: 'user', body: question });
	state.questions[data.node.key] = thread;
	state.asking.add(data.node.id);
	renderNarrative();
	try {
		const result = await api(`/ask/${data.node.id}`, {
			method: 'POST',
			body: JSON.stringify({ question, history: thread.slice(0, -1) }),
		});
		thread.push({ role: 'assistant', body: result.body });
		state.cost = result.cost;
		renderCost();
	} catch (error) {
		thread.push({ role: 'assistant', body: `I could not answer that: ${error.message}` });
	} finally {
		state.asking.delete(data.node.id);
		renderNarrative();
		$('narrative').scrollTop = $('narrative').scrollHeight;
	}
}

let reviewPollTimer = null;

function scheduleReviewPoll() {
	clearTimeout(reviewPollTimer);
	if (state.prReview?.status !== 'running') return;
	reviewPollTimer = setTimeout(refreshPrReview, 1400);
}

async function refreshPrReview() {
	try {
		state.prReview = await api('/review');
		if (state.detail) renderDetail();
	} catch (error) {
		toast(`Could not refresh the PR review: ${error.message}`, 5000);
	}
	scheduleReviewPoll();
}

async function startPrReview(deep = false) {
	if (state.prReview?.status === 'running') return;
	if (state.prReview?.status === 'complete' && !confirm('Run a new PR review and replace the result shown here? The previous persistent Codex session will remain available.')) return;
	state.prReview = {
		status: 'running', deep, activity: 'Starting Codex in the repository…',
		repoRoot: state.scope?.repoRoot,
	};
	if (state.detail) renderDetail();
	try {
		state.prReview = await api('/review', {
			method: 'POST',
			body: JSON.stringify({ deep, chunks: state.reviewPlan.chunks ?? [] }),
		});
		scheduleReviewPoll();
	} catch (error) {
		state.prReview = { status: 'failed', error: error.message };
		if (state.detail) renderDetail();
	}
}

async function openSource(path, line, reason = '') {
	try {
		const result = await api(`/source?path=${encodeURIComponent(path)}&line=${Number(line) || 1}`);
		if (state.trace) state.traceHistory.push(state.trace);
		state.trace = { ...result.source, path: result.path, target: result.target, symbol: result.symbol, reason };
		renderCode();
	} catch (error) {
		toast(error.message, 5000);
	}
}

function identifierAtPoint(event, container) {
	const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
	if (!range || !container.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE) return null;
	const text = range.startContainer.textContent ?? '';
	let start = range.startOffset;
	let end = range.startOffset;
	while (start > 0 && /[\w$]/.test(text[start - 1])) start--;
	while (end < text.length && /[\w$]/.test(text[end])) end++;
	const name = text.slice(start, end);
	return /^[A-Za-z_$][\w$]*$/.test(name) ? name : null;
}

async function followIdentifier(event, row) {
	const name = identifierAtPoint(event, row.querySelector('.src'));
	if (!name) return;
	const path = row.dataset.path;
	try {
		const result = await api(`/resolve?path=${encodeURIComponent(path)}&line=${row.dataset.n}&name=${encodeURIComponent(name)}`);
		await openSource(result.target.path, result.target.line, result.target.reason);
	} catch (error) {
		toast(error.message, 3800);
	}
}

async function followNamedIdentifier(path, name) {
	try {
		const result = await api(`/resolve?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name)}`);
		await openSource(result.target.path, result.target.line, result.target.reason);
	} catch (error) {
		toast(error.message, 3800);
	}
}

/* ---------- notes ---------- */

function renderCost() {
	const runner = state.agent?.name ?? 'codex';
	const spend = state.cost.calls && state.cost.totalUsd > 0 ? ` · $${state.cost.totalUsd.toFixed(2)}` : '';
	$('cost').textContent = `${runner}${spend}`;
	$('cost').title = `${runner}${state.agent?.model ? ` · ${state.agent.model}` : ' · current default model'} · ${state.cost.calls} model call(s) this session`;
}

function renderNotes() {
	$('note-count').textContent = String(state.notes.filter((note) => note.status === 'open').length);
	$('notes-list').innerHTML = state.notes.length
		? state.notes.map((note) => noteCardHtml(note)).join('')
		: '<div class="empty">No notes yet. Click a line number in the code.</div>';
}

function collectSelectedCode() {
	const rows = [...document.querySelectorAll('.cl.sel .src')].map((element) => element.textContent);
	return rows.length ? rows.join('\n').slice(0, 4000) : null;
}

async function saveNote() {
	const body = $('note-body')?.value?.trim();
	if (!body || !state.selection) return;
	const { path, side, start, end } = state.selection;
	const code = collectSelectedCode();
	try {
		await api('/notes', {
			method: 'POST',
			body: JSON.stringify({ path, side, startLine: start, endLine: end, body, code, nodeKey: state.detail?.node?.key ?? null }),
		});
		state.notes = await api('/notes');
		state.selection = null;
		renderNotes();
		renderDetail();
	} catch (error) {
		toast(`Could not save: ${error.message}`, 6000);
	}
}

/* ---------- export and posting ---------- */

function openModal(title, bodyHtml, actions) {
	$('modal-title').textContent = title;
	$('modal-body').innerHTML = bodyHtml;
	$('modal-actions').innerHTML = '';
	for (const action of actions) {
		if (action.spacer) { $('modal-actions').insertAdjacentHTML('beforeend', '<span class="spacer"></span>'); continue; }
		const button = document.createElement('button');
		button.className = action.primary ? 'btn primary' : 'btn';
		button.textContent = action.label;
		button.onclick = action.run;
		$('modal-actions').append(button);
	}
	$('modal').hidden = false;
}

const closeModal = () => { $('modal').hidden = true; };

async function openExport(format = 'md') {
	const text = await api(`/export?format=${format}&status=open`);
	openModal('Export notes', `<pre>${escapeHtml(text)}</pre>`, [
		{ label: 'markdown', run: () => openExport('md') },
		{ label: 'xml', run: () => openExport('xml') },
		{ label: 'json', run: () => openExport('json') },
		{ spacer: true },
		{
			label: 'Copy', primary: true, run: async () => {
				await navigator.clipboard.writeText(text);
				toast('Copied. Or run `unfold notes list` where your agent is.');
			},
		},
	]);
}

async function openPost() {
	if (!state.scope.prNumber) {
		toast('Not a pull request scope. Re-run with --pr <number> to post.', 5000);
		return;
	}
	const preview = await api('/github', { method: 'POST', body: JSON.stringify({ dryRun: true }) });
	if (!preview.payload) {
		toast('Nothing to post: every note is resolved or already posted.', 5000);
		return;
	}
	openModal(
		`Post ${preview.payload.comments.length} comment(s) to PR #${state.scope.prNumber}`,
		`<p>Optional review summary:</p><textarea id="post-summary"></textarea>
		 <p>Posts one <code>COMMENT</code> review. Nothing is approved or blocked.</p>
		 <pre>${escapeHtml(JSON.stringify(preview.payload.comments, null, 2))}</pre>`,
		[
			{ label: 'Cancel', run: closeModal },
			{ spacer: true },
			{
				label: 'Post review', primary: true, run: async () => {
					const summary = $('post-summary').value;
					closeModal();
					try {
						const result = await api('/github', { method: 'POST', body: JSON.stringify({ summary }) });
						state.notes = await api('/notes');
						renderNotes();
						renderDetail();
						toast(result.failed.length
							? `Posted ${result.posted}. GitHub refused ${result.failed.length} anchor(s): ${result.failed.map((f) => `${f.path}:${f.line}`).join(', ')}`
							: `Posted ${result.posted} comment(s).`, 9000);
					} catch (error) {
						toast(`Post failed: ${error.message}`, 9000);
					}
				},
			},
		],
	);
}

/* ---------- events ---------- */

async function refreshNotes() {
	state.notes = await api('/notes');
	renderNotes();
	renderDetail();
}

function wire() {
	$('tree').addEventListener('click', (event) => {
		const twisty = event.target.closest('[data-twisty]');
		if (twisty && twisty.textContent.trim()) { toggle(twisty.dataset.twisty); return; }
		const row = event.target.closest('.node-row');
		if (row?.dataset.id) selectNode(row.dataset.id, { scroll: false });
	});

	document.addEventListener('click', async (event) => {
		const goto = event.target.closest('[data-goto]');
		if (goto) { event.preventDefault(); selectNode(goto.dataset.goto); return; }
		const definitionLink = event.target.closest('[data-resolve-name]');
		if (definitionLink) {
			event.preventDefault();
			followNamedIdentifier(definitionLink.dataset.resolveFrom, definitionLink.dataset.resolveName);
			return;
		}
		const sourceLink = event.target.closest('[data-open-path]');
		if (sourceLink) {
			event.preventDefault();
			openSource(sourceLink.dataset.openPath, sourceLink.dataset.openLine, sourceLink.textContent.trim());
			return;
		}
		if (event.target.id === 'explain-one') { explain('shallow'); return; }
		if (event.target.id === 'explain-deep') { explain('deep'); return; }
		if (event.target.id === 'question-send') { askQuestion(); return; }
		if (event.target.id === 'review-run') { startPrReview(false); return; }
		if (event.target.id === 'review-deep') { startPrReview(true); return; }
		if (event.target.id === 'review-copy-resume') {
			await navigator.clipboard.writeText(event.target.dataset.resume);
			toast('Copied the Codex resume command.');
			return;
		}
		if (event.target.id === 'trace-close') { state.trace = null; state.traceHistory = []; renderCode(); return; }
		if (event.target.id === 'trace-back') { state.trace = state.traceHistory.pop() ?? null; renderCode(); return; }
		if (event.target.id === 'note-save') { saveNote(); return; }
		if (event.target.id === 'note-cancel') { state.selection = null; renderDetail(); return; }

		const toggleId = event.target.dataset?.noteToggle;
		const deleteId = event.target.dataset?.noteDelete;
		const gotoNote = event.target.closest('[data-note-goto]')?.dataset.noteGoto;
		if (toggleId) {
			const note = state.notes.find((candidate) => candidate.id === toggleId);
			await api(`/notes/${toggleId}`, { method: 'PATCH', body: JSON.stringify({ status: note.status === 'open' ? 'resolved' : 'open' }) });
			await refreshNotes();
		} else if (deleteId) {
			if (confirm('Delete this note?')) { await api(`/notes/${deleteId}`, { method: 'DELETE' }); await refreshNotes(); }
		} else if (gotoNote) {
			const note = state.notes.find((candidate) => candidate.id === gotoNote);
			const target = [...state.byId.values()].find((node) => node.key === note?.node_key);
			if (target) selectNode(target.id);
		}
	});

	$('code').addEventListener('click', (event) => {
		const gutter = event.target.closest('.gut');
		if (!gutter) {
			const source = event.target.closest('.src');
			const row = source?.closest('.cl');
			if (row) followIdentifier(event, row);
			return;
		}
		const row = gutter.closest('.cl');
		const n = Number(row.dataset.n);
		if (!n) return;
		const { path, side } = row.dataset;
		if (event.shiftKey && state.selection && state.selection.path === path && state.selection.side === side) {
			state.selection.start = Math.min(state.selection.start, n);
			state.selection.end = Math.max(state.selection.end, n);
		} else {
			state.selection = { path, side, start: n, end: n };
		}
		renderDetail();
		$('note-body')?.focus();
	});

	$('tree-toggle').onclick = () => document.querySelector('main').classList.toggle('no-tree');
	$('review-trigger').onclick = async () => {
		if (state.view !== 'path') await switchView('path');
		await selectNode(state.trees.path.id);
		requestAnimationFrame(() => $('agent-review')?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
	};
	$('view-toggle').onclick = () => switchView(state.view === 'path' ? 'files' : 'path');
	$('notes-toggle').onclick = () => { $('notes-pane').hidden = !$('notes-pane').hidden; };
	$('notes-close').onclick = () => { $('notes-pane').hidden = true; };
	$('export-btn').onclick = () => openExport('md');
	$('post-btn').onclick = () => openPost();
	$('modal-close').onclick = closeModal;
	$('expand-all').onclick = () => { expandAll(); renderTree(); };
	$('collapse-all').onclick = () => { state.expanded = new Set([state.tree.id]); renderTree(); };
	$('show-hunks').onchange = (event) => { state.showHunks = event.target.checked; renderTree(); };
	$('filter').oninput = (event) => { state.filter = event.target.value.trim(); renderTree(); };

	document.addEventListener('keydown', (event) => {
		if (event.target.matches('input, textarea')) {
			if (event.key === 'Escape') event.target.blur();
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target.id === 'note-body') saveNote();
			if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && event.target.id === 'question-body') askQuestion();
			return;
		}
		const rows = visibleRows(state.tree);
		const at = rows.findIndex((row) => row.node.id === state.selectedId);
		if (event.key === 'j' || event.key === 'ArrowDown') { event.preventDefault(); if (rows[at + 1]) selectNode(rows[at + 1].node.id); }
		else if (event.key === 'k' || event.key === 'ArrowUp') { event.preventDefault(); if (rows[at - 1]) selectNode(rows[at - 1].node.id); }
		else if (event.key === 'ArrowRight') toggle(state.selectedId, true);
		else if (event.key === 'ArrowLeft') toggle(state.selectedId, false);
		else if (event.key === 'e') explain('shallow');
		else if (event.key === 'E') explain('deep');
		else if (event.key === '/') { event.preventDefault(); $('filter').focus(); }
		else if (event.key === 'Escape') { closeModal(); state.selection = null; renderDetail(); }
	});
}

/* ---------- boot ---------- */

/** The path and the file tree are two readings of one diff; keys are shared. */
async function switchView(view) {
	if (view === state.view) return;
	if (view === 'files' && !state.trees.files) {
		const response = await api('/files');
		state.trees.files = response.tree;
		indexTree(response.tree);
	}
	state.view = view;
	state.tree = state.trees[view];
	$('view-toggle').textContent = view === 'path' ? 'Files' : 'Blocks';
	state.expanded = new Set([state.tree.id, ...state.tree.children.filter((child) => !child.appendix).map((child) => child.id)]);
	renderTree();
	selectNode(state.tree.id);
}

function applyReviewPlan(chunks) {
	const root = state.trees.path;
	const nodes = new Map(root.children.filter((child) => child.kind === 'block' && !child.appendix).map((child) => [child.id, child]));
	const originalMeta = new Map((state.rootPayload?.reviewBlocks ?? []).map((block) => [block.id, block]));
	state.planByBlock = new Map();
	const ordered = [];
	for (const chunk of chunks) {
		const node = nodes.get(chunk.blockId);
		if (!node || state.planByBlock.has(node.id)) continue;
		state.planByBlock.set(node.id, chunk);
		node.reviewPlan = chunk;
		ordered.push(node);
	}
	// The server also validates coverage; this guard keeps the UI complete if an
	// older server or interrupted response returns only part of the plan.
	for (const node of nodes.values()) if (!state.planByBlock.has(node.id)) ordered.push(node);
	const appendices = root.children.filter((child) => child.appendix);
	root.children = [...ordered, ...appendices];
	BLOCK_NUMBER.clear();
	ordered.forEach((node, index) => BLOCK_NUMBER.set(node.id, index + 1));
	state.rootPayload.reviewBlocks = ordered.map((node) => originalMeta.get(node.id) ?? {
		id: node.id, label: node.label, type: node.blockType, parts: node.children.length,
	});
	state.totalBlocks = ordered.length;
	renderProgress();
	renderTree();
	if (state.detail) renderDetail();
}

async function loadReviewPlan() {
	if (state.reviewPlan.status !== 'idle') return;
	state.reviewPlan.status = 'loading';
	if (state.detail?.node.kind === 'root') renderNarrative();
	try {
		const result = await api('/plan', { method: 'POST', body: '{}' });
		state.reviewPlan = {
			status: 'ready', chunks: result.chunks ?? [], generated: Boolean(result.generated),
			warning: result.warning ?? null,
		};
		applyReviewPlan(state.reviewPlan.chunks);
		if (result.cost) { state.cost = result.cost; renderCost(); }
	} catch (error) {
		state.reviewPlan = {
			status: 'ready', chunks: [], generated: false,
			warning: `Could not create the AI review plan: ${error.message}`,
		};
		if (state.detail?.node.kind === 'root') renderNarrative();
	}
}

async function loadIntentBrief() {
	if (state.brief.status !== 'idle') return;
	state.brief.status = 'loading';
	if (state.detail?.node.kind === 'root') renderNarrative();
	try {
		const result = await api('/brief', { method: 'POST', body: '{}' });
		state.brief = {
			status: 'ready', body: result.body, generated: Boolean(result.generated),
			linearIssues: result.linearIssues ?? [], warning: result.warning ?? null,
		};
		if (result.cost) { state.cost = result.cost; renderCost(); }
	} catch (error) {
		state.brief = {
			status: 'ready', generated: false, linearIssues: [],
			body: state.rootPayload?.prBody?.trim() || 'The PR description does not establish the intended outcome.',
			warning: `Could not create the intent briefing: ${error.message}`,
		};
	}
	if (state.detail?.node.kind === 'root') renderNarrative();
}

async function boot() {
	const run = await api('/run');
	state.scope = run.scope;
	state.agent = run.agent ?? state.agent;
	state.tree = run.tree;
	state.trees.path = run.tree;
	state.stepOrder = run.stepOrder ?? [];
	state.totalSteps = run.totalSteps ?? 0;
	state.totalBlocks = run.totalBlocks ?? run.rootPayload?.reviewBlocks?.length ?? 0;
	state.rootPayload = run.rootPayload ?? null;
	state.explanations = run.explanations;
	state.notes = run.notes;
	state.cost = run.cost;
	indexTree(state.tree);
	try { state.prReview = await api('/review'); } catch { state.prReview = { status: 'idle' }; }

	// Keep the block list scannable; opening a block reveals its repeated code.
	state.expanded.add(state.tree.id);
	state.tree.children.forEach((child, index) => {
		if (child.kind === 'block' && !child.appendix) BLOCK_NUMBER.set(child.id, index + 1);
		if (child.appendix) return;
		for (const concept of child.children) {
			if (concept.children.some((grandchild) => grandchild.endpoint)) state.expanded.add(concept.id);
		}
	});

	const scope = run.scope;
	$('scope-line').textContent = scope.prNumber
		? `PR #${scope.prNumber} · ${scope.headRef}`
		: `${scope.baseRef} → ${scope.headRef}`;
	$('totals').innerHTML = counts(run.tree);
	document.title = `unfold · ${scope.prTitle ?? scope.headRef}`;

	// Three comfortable columns need room; below that the tree starts folded away.
	document.querySelector('main').classList.toggle('no-tree', window.innerWidth < 1180);

	renderCost();
	renderProgress();
	renderTree();
	renderNotes();
	wire();
	await selectNode(state.tree.id);
	scheduleReviewPoll();
	loadIntentBrief();
	loadReviewPlan();
}

boot().catch((error) => {
	document.body.innerHTML = `<div class="empty" style="padding:40px">Could not start: ${escapeHtml(error.message)}</div>`;
});
