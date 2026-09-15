const token = window.UNFOLD_TOKEN;

const state = {
	scope: null,
	tree: null,
	trees: { path: null, files: null },
	view: 'path',
	stepOrder: [],
	totalSteps: 0,
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
	cost: { totalUsd: 0, calls: 0 },
	busy: new Set(),
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
		out.push(heading ? `<p><strong>${inline(heading[2])}</strong></p>` : `<p>${inline(raw)}</p>`);
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

const LAYER_NUMBER = new Map();

/** No kind badges: indentation carries the hierarchy and the label carries the name. */
function rowHtml({ node, depth }) {
	const children = state.showHunks ? node.children : node.children.filter((child) => child.kind !== 'hunk');
	const open = state.expanded.has(node.id);
	const classes = [
		'node-row',
		node.id === state.selectedId ? 'selected' : '',
		node.excluded ? 'excluded' : '',
		node.kind === 'root' ? 'is-root' : '',
		node.kind === 'layer' ? 'is-layer' : '',
		node.kind === 'file' || node.kind === 'group' ? 'is-path' : '',
		node.endpoint ? 'is-endpoint' : '',
	].filter(Boolean).join(' ');
	const stage = node.kind === 'layer' ? `${LAYER_NUMBER.get(node.id) ?? ''} · ` : '';
	return `<li>
		<div class="${classes}" data-id="${node.id}" style="padding-left:${8 + depth * 12}px" role="treeitem" title="${escapeHtml(node.path ?? node.label)}">
			<span class="twisty ${children.length ? '' : 'leaf'}" data-twisty="${node.id}">${children.length ? (open ? '▼' : '▶') : ''}</span>
			<span class="mark ${state.explanations[node.key] ? 'explained' : ''}"></span>
			<span class="label">${stage}${treeLabel(node)}</span>
			<span class="n">${counts(node)}</span>
		</div>
	</li>`;
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
	const stages = (state.trees.path?.children ?? []).filter((child) => child.kind === 'layer');
	const stageList = stages.map((stage, index) => `<button class="jump" data-goto="${stage.id}">
			<span class="mark ${state.explanations[stage.key] ? 'explained' : ''}"></span>
			<span>${index + 1} · ${escapeHtml(stage.label)}</span>
			<span class="n">${stage.children.length} · ${stage.added}/${stage.removed}</span>
		</button>`).join('');
	const endpointList = endpoints.length
		? endpoints.map((entry) => `<div class="endpoint">
				<div class="route"><span class="verb ${entry.verb.toLowerCase()}">${entry.verb}</span> <code>${escapeHtml(entry.route)}</code></div>
				<div class="guards">${escapeHtml(entry.scope ?? 'no scope')}${entry.licence ? ` · ${escapeHtml(entry.licence)}` : ''}${entry.limit ? ' · rate limited' : ''} · ${escapeHtml(entry.auth)}</div>
			</div>`).join('')
		: '<div class="hit">No route decorators changed in this diff.</div>';
	return `
		<div class="group"><span class="eyebrow">Trigger surface</span>${endpointList}</div>
		<div class="group"><span class="eyebrow">The path, in build order</span>${stageList}</div>`;
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
	return `<div class="placeholder">Not explained yet. <kbd>e</kbd> explains this node${
		hasChildren ? ', <kbd>E</kbd> explains everything under it and composes upward' : ''}.</div>`;
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
	const hit = (item) => `<div class="hit"><span class="where">${escapeHtml(item.path)}:${item.line}</span> ${escapeHtml(truncate(item.text ?? '', 90))}</div>`;
	const cards = [];
	const resolved = (context.dependencies ?? []).filter((dep) => dep.resolved);

	if (resolved.length) {
		cards.push(['Imports it relies on', resolved.length, resolved.map((dep) =>
			`<div class="hit"><code>${escapeHtml(dep.local)}</code> → <span class="where">${escapeHtml(dep.resolved)}${dep.declaration ? `:${dep.declaration.line}` : ''}</span></div>`).join('')]);
	}
	if (context.callers?.length) {
		cards.push([`Used by, in ${escapeHtml(context.searchedIn ?? '')}`, context.callers.length, context.callers.map(hit).join('')]);
	}
	if (context.sameFile?.length) {
		cards.push(['Used in this file', context.sameFile.length, context.sameFile.map((item) =>
			`<div class="hit"><span class="where">L${item.line}</span> ${escapeHtml(truncate(item.text, 90))}</div>`).join('')]);
	}
	if (context.localReferences?.length) {
		cards.push(['Declared alongside it', context.localReferences.length, context.localReferences.map((ref) =>
			`<div class="hit">${escapeHtml(ref.kind)} <code>${escapeHtml(ref.name)}</code> <span class="where">L${ref.start}</span></div>`).join('')]);
	}
	if (context.tests?.length) {
		cards.push(['Tests that name it', context.tests.length, context.tests.map(hit).join('')]);
	}
	if (context.importers?.length) {
		cards.push(['Files importing this one', context.importers.length, context.importers.map(hit).join('')]);
	}
	if (!cards.length) return '';
	return `<div class="group"><span class="eyebrow">Code already there</span>${cards.map(([title, count, body]) =>
		`<details class="card"><summary>${title} <span class="n">${count}</span></summary><div class="card-body">${body}</div></details>`).join('')}</div>`;
}

const MAX_JUMPS = 24;

function childrenHtml(children) {
	const worth = children.filter((child) => child.kind !== 'hunk');
	if (!worth.length) return '';
	const shown = worth.slice(0, MAX_JUMPS);
	return `<div class="group"><span class="eyebrow">Unfold into</span>
		${shown.map((child) => `<button class="jump" data-goto="${child.id}">
			<span class="mark ${child.explained ? 'explained' : ''}"></span>
			<span class="${child.kind === 'file' ? 'mono' : ''}">${escapeHtml(truncate(child.label, 44))}</span>
			<span class="n">${child.added}/${child.removed}</span>
		</button>`).join('')}
		${worth.length > shown.length ? `<div class="hit">+${worth.length - shown.length} more in the tree</div>` : ''}</div>`;
}

function renderNarrative() {
	const data = state.detail;
	const here = notesHere(data);
	const payload = data.node.payload ?? {};
	const isEndpoint = Boolean(payload.facts);
	const isMono = !isEndpoint && (data.node.kind === 'file' || data.node.kind === 'group');
	const label = data.node.kind === 'file' ? data.node.label.split('/').pop() : data.node.label;
	const hasChildren = data.children.some((child) => child.kind !== 'hunk');
	const { previous, next } = stepNeighbours();
	const parts = [
		isEndpoint ? null : payload.symbolKind,
		payload.status,
		payload.exported ? 'exported' : null,
		payload.path && data.node.kind !== 'file' ? payload.path.split('/').pop() : null,
		data.node.hunkCount ? `${data.node.hunkCount} change group${data.node.hunkCount > 1 ? 's' : ''}` : null,
	].filter(Boolean);

	$('narrative').innerHTML = `
		${crumbHtml(data.breadcrumb)}
		${payload.step ? `<div class="step">Step ${payload.step} of ${state.totalSteps}</div>` : ''}
		<h1 class="title ${isMono ? 'mono' : ''} ${isEndpoint ? 'route' : ''}">${escapeHtml(label)}</h1>
		<div class="sub">${counts(data.node)}${parts.length ? ` · ${escapeHtml(parts.join(' · '))}` : ''}${payload.blurb ? ` — ${escapeHtml(payload.blurb)}` : ''}</div>
		<div class="actions">
			<button class="btn primary" id="explain-one">${data.explanations.shallow ? 'Re-explain' : (data.node.kind === 'root' ? 'Explain this change' : 'Explain')}</button>
			${hasChildren ? `<button class="btn" id="explain-deep">${data.explanations.deep ? 'Redo stage' : 'Explain everything under it'}</button>` : ''}
		</div>
		${factsPanelHtml(payload.facts)}
		<div class="group">${explanationHtml(data)}</div>
		${data.node.kind === 'root' ? overviewHtml() : ''}
		${composeHtml()}
		${here.length ? `<div class="group"><span class="eyebrow">Notes here</span>${here.map((note) => noteCardHtml(note, { compact: true })).join('')}</div>` : ''}
		${contextHtml(data.context)}
		${data.node.kind === 'root' ? '' : childrenHtml(data.children)}
		${previous || next ? `<div class="pager">
			${previous ? `<button class="btn" data-goto="${previous}">← previous</button>` : '<span></span>'}
			${next ? `<button class="btn primary" data-goto="${next}">next step →</button>` : '<span></span>'}
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

function renderCode() {
	const data = state.detail;
	const noted = notedLines();
	const hasCode = Boolean(data.hunks.length || data.source);
	document.querySelector('main').classList.toggle('no-code', !hasCode);
	if (!hasCode) {
		$('code').innerHTML = '';
		return;
	}
	const path = data.node.payload?.path ?? '';
	$('code').innerHTML = `
		${path ? `<div class="file-head"><span class="path">${escapeHtml(path)}</span><span class="meta">${counts(data.node)}</span></div>` : ''}
		${data.hunks.length ? `<div class="group"><span class="eyebrow">Changed lines</span>${changedLinesHtml(data.hunks, noted)}</div>` : ''}
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
	const worth = node.children.filter((child) => child.kind !== 'hunk');
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

/* ---------- notes ---------- */

function renderCost() {
	$('cost').textContent = state.cost.calls ? `$${state.cost.totalUsd.toFixed(2)}` : '';
	$('cost').title = `${state.cost.calls} model call(s) this session`;
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
		if (event.target.id === 'explain-one') { explain('shallow'); return; }
		if (event.target.id === 'explain-deep') { explain('deep'); return; }
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
		if (!gutter) return;
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
	$('view-toggle').textContent = view === 'path' ? 'Files' : 'Path';
	state.expanded = new Set([state.tree.id, ...state.tree.children.map((child) => child.id)]);
	renderTree();
	selectNode(state.tree.id);
}

async function boot() {
	const run = await api('/run');
	state.scope = run.scope;
	state.tree = run.tree;
	state.trees.path = run.tree;
	state.stepOrder = run.stepOrder ?? [];
	state.totalSteps = run.totalSteps ?? 0;
	state.rootPayload = run.rootPayload ?? null;
	state.explanations = run.explanations;
	state.notes = run.notes;
	state.cost = run.cost;
	indexTree(state.tree);

	// Every stage open, contents folded: the path is visible, the detail is not.
	state.expanded.add(state.tree.id);
	state.tree.children.forEach((child, index) => {
		state.expanded.add(child.id);
		if (child.kind === 'layer') LAYER_NUMBER.set(child.id, index + 1);
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
	renderTree();
	renderNotes();
	wire();
	selectNode(state.tree.id);
}

boot().catch((error) => {
	document.body.innerHTML = `<div class="empty" style="padding:40px">Could not start: ${escapeHtml(error.message)}</div>`;
});
