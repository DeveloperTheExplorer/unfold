import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { LAYER_IDS, classifyConcept, endpointFacts } from './layers.js';

/**
 * Turns changed symbols into independently reviewable feature/bug blocks.
 * A block follows references from one behavioural anchor into the changed code
 * it relies on. Anchors are never merged merely because they share a helper;
 * the helper is cloned into both blocks so each flow can be assessed whole.
 */

const TREE_VERSION = 'feature-blocks-v1';
const TEST_PATH = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const DOC_PATH = /\.(md|mdx|rst|txt)$/i;
const FILE_BLOCK_PATH = /\.(md|mdx|rst|txt|css|scss|sass|less)$/i;
const SUPPORT_ROLES = new Set(['contracts', 'wiring', 'imports']);
const BUG_WORDS = /\b(fix(?:e[ds])?|bug|regression|broken|incorrect|crash|prevent|repair|resolve[ds]?)\b/i;
const FEATURE_WORDS = /\b(add(?:ed|s)?|introduc(?:e|ed|es)|support(?:ed|s)?|enable[ds]?|allow[eds]?|implement(?:ed|s)?|feature|new)\b/i;
const STOP_WORDS = new Set(['this', 'that', 'with', 'from', 'into', 'when', 'where', 'what', 'then', 'than', 'have', 'will', 'code', 'change', 'changes', 'update', 'updates']);

const sha = (...parts) => {
	const hash = createHash('sha256');
	hash.update(TREE_VERSION);
	for (const part of parts) hash.update(String(part));
	return hash.digest('hex').slice(0, 16);
};

class Builder {
	constructor() { this.nodes = []; }

	add({ key, parent, kind, label, ...rest }) {
		const node = {
			id: `B${this.nodes.length + 1}`, key, kind, label,
			parentId: parent ? parent.id : null,
			depth: parent ? parent.depth + 1 : 0,
			children: [], added: 0, removed: 0, fileCount: 0, hunkCount: 0,
			...rest,
		};
		this.nodes.push(node);
		if (parent) parent.children.push(node);
		return node;
	}
}

function bodyOf(sources, path, start, end) {
	const text = sources.get(path);
	if (!text || !start) return '';
	return text.split('\n').slice(start - 1, end).join('\n');
}

function directStats(hunks) {
	return hunks.reduce((stats, hunk) => ({
		added: stats.added + hunk.added,
		removed: stats.removed + hunk.removed,
	}), { added: 0, removed: 0 });
}

/** Smallest code units that own changed lines: symbols with direct hunks. */
function collectConcepts(fileTree) {
	const concepts = [];
	for (const fileNode of fileTree.nodes) {
		if (fileNode.kind !== 'file') continue;
		const path = fileNode.payload.path ?? fileNode.payload.newPath ?? fileNode.label;
		const fileText = fileTree.sources.get(path) ?? '';
		const addSymbol = (source) => {
			const hunks = source.children.filter((child) => child.kind === 'hunk');
			if (hunks.length) {
				const batches = source.payload.symbolKind === 'module' ? hunks.map((hunk) => [hunk]) : [hunks];
				for (const batch of batches) {
					const body = source.payload.symbolKind === 'module'
						? batch.flatMap((hunk) => hunk.payload.lines.filter((line) => line.t !== ' ').map((line) => line.s)).join('\n')
						: bodyOf(fileTree.sources, path, source.payload.start, source.payload.end);
					const role = fileNode.payload.excluded
						? 'other'
						: source.payload.symbolKind === 'module'
							? 'imports'
							: classifyConcept({ path, symbolKind: source.payload.symbolKind, body, fileText });
					concepts.push({
						id: batch.length === hunks.length ? source.key : `${source.key}|${batch[0].key}`,
						source, hunks: batch, path, fileKey: fileNode.key, fileText,
						outline: fileNode.payload.symbolIndex ?? [], body, role,
						excluded: Boolean(fileNode.payload.excluded), status: fileNode.payload.status,
						facts: endpointFacts({ symbolKind: source.payload.symbolKind, body, fileText }),
						...directStats(batch),
					});
				}
			}
			source.children.filter((child) => child.kind === 'symbol').forEach(addSymbol);
		};
		fileNode.children.filter((child) => child.kind === 'symbol').forEach(addSymbol);

		const looseHunks = fileNode.children.filter((child) => child.kind === 'hunk');
		if (looseHunks.length) {
			const body = looseHunks.flatMap((hunk) => hunk.payload.lines.map((line) => line.s)).join('\n');
			concepts.push({
				id: `loose|${path}`, source: null, hunks: looseHunks, path, fileKey: fileNode.key,
				fileText, outline: fileNode.payload.symbolIndex ?? [], body,
				role: fileNode.payload.excluded ? 'other' : classifyConcept({ path, body, fileText }),
				excluded: Boolean(fileNode.payload.excluded), status: fileNode.payload.status, facts: null,
				label: basename(path), ...directStats(looseHunks),
			});
		}
	}
	return concepts;
}

const identifier = (value) => /^[A-Za-z_$][\w$]*$/.test(value ?? '') && value.length > 2;

/** Reference edges point from changed behaviour to the changed code it uses. */
function connectConcepts(concepts) {
	const byName = new Map();
	const files = new Map();
	for (const concept of concepts) if (!files.has(concept.path)) files.set(concept.path, concept);
	for (const [path, file] of files) {
		for (const symbol of file.outline ?? []) {
			if (!identifier(symbol.name)) continue;
			const key = `${path}:${symbol.start}:${symbol.end}`;
			const record = {
				key, name: symbol.name, path,
				body: file.fileText.split('\n').slice(symbol.start - 1, symbol.end).join('\n'),
			};
			if (!byName.has(symbol.name)) byName.set(symbol.name, []);
			byName.get(symbol.name).push(record);
		}
	}
	const changedByVirtual = new Map();
	for (const concept of concepts) {
		if (!concept.source?.payload.start) continue;
		changedByVirtual.set(`${concept.path}:${concept.source.payload.start}:${concept.source.payload.end}`, concept);
	}
	for (const concept of concepts) {
		concept.dependencies = new Set();
		concept.incoming = new Set();
	}
	const resolve = (name, path) => {
		const candidates = byName.get(name) ?? [];
		const sameFile = candidates.filter((candidate) => candidate.path === path);
		return sameFile.length === 1 ? sameFile : candidates.length === 1 ? candidates : [];
	};
	for (const concept of concepts) {
		const queue = [{ body: concept.body, path: concept.path }];
		const visited = new Set();
		while (queue.length && visited.size < 200) {
			const current = queue.shift();
			for (const token of new Set(current.body.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
				for (const symbol of resolve(token, current.path)) {
					if (visited.has(symbol.key)) continue;
					visited.add(symbol.key);
					const changed = changedByVirtual.get(symbol.key);
					if (changed && changed !== concept) concept.dependencies.add(changed);
					else queue.push(symbol);
				}
			}
		}
	}
	for (const concept of concepts) {
		for (const dependency of concept.dependencies) dependency.incoming.add(concept);
	}
}

function words(value) {
	return new Set(String(value ?? '')
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.toLowerCase().match(/[a-z0-9]{3,}/g)?.filter((word) => !STOP_WORDS.has(word)) ?? []);
}

function intentItems(payload) {
	const items = [];
	const add = (text, order) => {
		const clean = String(text ?? '').replace(/^[-*#\s]+/, '').replace(/^\w{7,40}\s+/, '').trim();
		if (clean.length >= 5 && clean.length <= 240 && !items.some((item) => item.text === clean)) {
			items.push({ text: clean, order, words: words(clean) });
		}
	};
	add(payload.prTitle, 0);
	String(payload.prBody ?? '').split('\n').forEach((line, index) => {
		if (/^\s*(?:[-*]|#{1,6})\s+/.test(line)) add(line, index + 1);
	});
	(payload.commits ?? []).forEach((commit, index) => add(commit, 1000 + index));
	return items;
}

function intentFor(concept, items) {
	const signal = words(`${concept.source?.label ?? concept.label ?? ''} ${concept.path}`);
	let best = null;
	for (const item of items) {
		let score = 0;
		for (const word of signal) if (item.words.has(word)) score++;
		if (!best || score > best.score || (score === best.score && item.order < best.item.order)) best = { item, score };
	}
	return best?.score ? best : null;
}

function blockTypeFor(anchor, intent, payload) {
	const evidence = intent?.item.text ?? payload.prTitle ?? '';
	if (BUG_WORDS.test(evidence)) return 'bug';
	if (FEATURE_WORDS.test(evidence)) return 'feature';
	if (SUPPORT_ROLES.has(anchor.role) || DOC_PATH.test(anchor.path)) return 'change';
	return anchor.added > 0 ? 'feature' : 'change';
}

function blockLabel(anchor) {
	if (DOC_PATH.test(anchor.path)) return `Documentation · ${basename(anchor.path)}`;
	if (/\.(css|scss|sass|less)$/i.test(anchor.path)) return `Interface styling · ${basename(anchor.path)}`;
	if (anchor.source?.payload.symbolKind === 'module') return `Top level · ${basename(anchor.path)}`;
	if (anchor.facts) return `${anchor.facts.verb} ${anchor.facts.route}`;
	return anchor.source?.label ?? anchor.label ?? basename(anchor.path);
}

function behaviouralIncoming(concept) {
	return [...concept.incoming].filter((source) => !SUPPORT_ROLES.has(source.role) && !TEST_PATH.test(source.path));
}

function mainAnchors(concepts) {
	const anchors = [];
	const seenDocs = new Set();
	for (const concept of concepts) {
		if (concept.excluded || concept.role === 'tests' || TEST_PATH.test(concept.path)) continue;
		if (FILE_BLOCK_PATH.test(concept.path)) {
			if (!seenDocs.has(concept.path)) { anchors.push(concept); seenDocs.add(concept.path); }
			continue;
		}
		const orchestrationBoundary = concept.dependencies.size >= 6
			|| (concept.hunks.length > 2 && concept.dependencies.size >= 3);
		if (concept.facts || (!SUPPORT_ROLES.has(concept.role)
			&& (behaviouralIncoming(concept).length === 0 || orchestrationBoundary))) anchors.push(concept);
	}
	return anchors;
}

function closureFor(anchor, anchors, concepts) {
	if (FILE_BLOCK_PATH.test(anchor.path)) return new Set(concepts.filter((concept) => concept.path === anchor.path && !concept.excluded));
	const members = new Set();
	const walk = (concept) => {
		if (members.has(concept) || concept.excluded || concept.role === 'tests' || TEST_PATH.test(concept.path)) return;
		if (concept !== anchor && anchors.has(concept)) return;
		members.add(concept);
		for (const dependency of concept.dependencies) walk(dependency);
	};
	walk(anchor);

	// Registration and imports point toward behaviour rather than being called by
	// it. Pull those one-hop support changes into every block they activate.
	let added = true;
	while (added) {
		added = false;
		for (const concept of concepts) {
			if (members.has(concept) || concept.excluded || !SUPPORT_ROLES.has(concept.role)) continue;
			if ([...concept.dependencies].some((dependency) => members.has(dependency))) {
				members.add(concept);
				added = true;
			}
		}
	}
	return members;
}

function cloneHunk(builder, source, parent, blockKey, role, shared) {
	const node = builder.add({
		key: `${blockKey}|${source.key}`, parent, kind: 'hunk', label: source.label,
		payload: { ...source.payload, layer: role, sourceKey: source.key, shared },
	});
	node.added = source.added;
	node.removed = source.removed;
	node.hunkCount = 1;
	node.contentHash = sha(source.contentHash, blockKey);
	return node;
}

function cloneConcept(builder, concept, parent, blockKey, shared) {
	const source = concept.source;
	const label = concept.facts ? `${concept.facts.verb} ${concept.facts.route}` : source?.label ?? concept.label;
	const node = builder.add({
		key: `${blockKey}|${concept.id}`, parent, kind: 'symbol', label,
		payload: {
			...(source?.payload ?? {}), path: concept.path, layer: concept.role,
			facts: concept.facts, fileKey: concept.fileKey, isConcept: true,
			sourceKey: concept.id, shared,
			symbolKind: source?.payload.symbolKind ?? concept.status ?? 'file',
		},
	});
	for (const hunk of concept.hunks) cloneHunk(builder, hunk, node, blockKey, concept.role, shared);
	return node;
}

function finalise(node) {
	if (!node.children.length) {
		node.contentHash = node.contentHash ?? sha(node.key);
		return node;
	}
	const hashes = [];
	for (const child of node.children) {
		finalise(child);
		node.added += child.added;
		node.removed += child.removed;
		node.hunkCount += child.hunkCount;
		hashes.push(child.contentHash);
	}
	node.contentHash = sha(node.key, ...hashes);
	return node;
}

function assignSteps(root) {
	let step = 0;
	const order = [];
	const walk = (node) => {
		if (node.kind === 'hunk' || node.payload?.appendix) return;
		if (node.kind !== 'root') {
			node.payload = { ...node.payload, step: ++step };
			order.push(node.id);
		}
		node.children.forEach(walk);
	};
	walk(root);
	root.payload.totalSteps = step;
	root.payload.stepOrder = order;
}

function sortMembers(members) {
	const roleOrder = new Map(LAYER_IDS.map((role, index) => [role, index]));
	return [...members].sort((a, b) =>
		(roleOrder.get(a.role) ?? 99) - (roleOrder.get(b.role) ?? 99)
		|| a.path.localeCompare(b.path)
		|| (a.source?.payload.start ?? 0) - (b.source?.payload.start ?? 0));
}

export function buildFeatureTree(fileTree, scope) {
	const builder = new Builder();
	const concepts = collectConcepts(fileTree);
	connectConcepts(concepts);
	const intent = intentItems(fileTree.root.payload);
	const anchors = mainAnchors(concepts);
	const anchorSet = new Set(anchors);
	const memberships = anchors.map((anchor) => ({ anchor, members: closureFor(anchor, anchorSet, concepts) }));
	const covered = new Set(memberships.flatMap(({ members }) => [...members]));

	// A contract or isolated helper may have no behavioural anchor in this diff.
	// It still becomes a small honest block rather than falling out of the path.
	for (const concept of concepts) {
		if (covered.has(concept) || concept.excluded || concept.role === 'tests' || TEST_PATH.test(concept.path)) continue;
		if (concept.source?.payload.symbolKind === 'module') continue;
		const members = closureFor(concept, new Set([...anchorSet, concept]), concepts);
		memberships.push({ anchor: concept, members });
		for (const member of members) covered.add(member);
	}
	const topLevel = concepts.filter((concept) => !covered.has(concept) && !concept.excluded
		&& concept.role !== 'tests' && !TEST_PATH.test(concept.path)
		&& concept.source?.payload.symbolKind === 'module');

	const frequency = new Map();
	for (const { members } of memberships) {
		for (const concept of members) frequency.set(concept, (frequency.get(concept) ?? 0) + 1);
	}

	const endpoints = concepts.filter((concept) => concept.facts).map((concept) => ({
		...concept.facts, path: concept.path, symbol: concept.source?.label ?? concept.label,
	})).sort((a, b) => a.route.localeCompare(b.route) || a.verb.localeCompare(b.verb));
	const root = builder.add({
		key: 'overview', parent: null, kind: 'root',
		label: scope.prTitle ?? `${scope.baseRef} → ${scope.headRef}`,
		payload: { ...fileTree.root.payload, entryPoints: endpoints },
	});

	const blockNodes = [];
	for (const [index, membership] of memberships.entries()) {
		const { anchor, members } = membership;
		if (!members.size) continue;
		const matchedIntent = intentFor(anchor, intent);
		const blockType = blockTypeFor(anchor, matchedIntent, fileTree.root.payload);
		const blockKey = `block|${sha(anchor.id, index)}`;
		const sharedCount = [...members].filter((concept) => (frequency.get(concept) ?? 0) > 1).length;
		const block = builder.add({
			key: blockKey, parent: root, kind: 'block', label: membership.label ?? blockLabel(anchor),
			payload: {
				blockType, blockIndex: blockNodes.length + 1,
				blurb: matchedIntent?.item.text ?? null,
				sharedCount,
			},
		});
		for (const concept of sortMembers(members)) {
			cloneConcept(builder, concept, block, blockKey, (frequency.get(concept) ?? 0) > 1);
		}
		block.fileCount = new Set([...members].map((concept) => concept.path)).size;
		blockNodes.push(block);
	}

	const appendices = [
		{ label: 'Supporting imports and top-level changes', type: 'support', concepts: topLevel },
		{ label: 'Excluded from analysis', type: 'excluded', concepts: concepts.filter((concept) => concept.excluded) },
		{ label: 'Tests', type: 'tests', concepts: concepts.filter((concept) => !concept.excluded && (concept.role === 'tests' || TEST_PATH.test(concept.path))) },
	];
	for (const appendix of appendices) {
		if (!appendix.concepts.length) continue;
		const key = `appendix|${appendix.type}`;
		const block = builder.add({
			key, parent: root, kind: 'block', label: appendix.label,
			payload: { blockType: appendix.type, appendix: true, layer: appendix.type },
		});
		for (const concept of sortMembers(new Set(appendix.concepts))) cloneConcept(builder, concept, block, key, false);
		block.fileCount = new Set(appendix.concepts.map((concept) => concept.path)).size;
	}

	finalise(root);
	// The block tree intentionally repeats overlap; the overview still reports
	// the physical diff totals rather than counting shared lines twice.
	root.added = fileTree.root.added;
	root.removed = fileTree.root.removed;
	root.hunkCount = fileTree.root.hunkCount;
	root.fileCount = fileTree.root.fileCount;
	assignSteps(root);
	root.payload.reviewBlocks = blockNodes.map((block) => ({
		id: block.id, label: block.label, type: block.payload.blockType,
		parts: block.children.length, shared: block.payload.sharedCount, intent: block.payload.blurb,
	}));
	root.payload.totalBlocks = blockNodes.length;
	root.payload.overlapCount = [...frequency.values()].filter((count) => count > 1).length;
	return { root, nodes: builder.nodes };
}
