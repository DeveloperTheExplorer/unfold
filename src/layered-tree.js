import { createHash } from 'node:crypto';
import { LAYER_IDS, layerMeta, classifyConcept, endpointFacts } from './layers.js';

/**
 * Re-arranges the change into the order it would have been built, over the same
 * hunks the file tree found. Every hunk still lands in exactly one place, so the
 * two views are two readings of one diff, not two different diffs.
 */

// Folded into every content hash so a prompt change re-explains rather than
// showing prose written to an older template.
const PROMPT_VERSION = 'v2';

const sha = (...parts) => {
	const hash = createHash('sha256');
	hash.update(PROMPT_VERSION);
	for (const part of parts) hash.update(String(part));
	return hash.digest('hex').slice(0, 16);
};

class Builder {
	constructor() {
		this.nodes = [];
	}

	add({ key, parent, kind, label, ...rest }) {
		const node = {
			id: `L${this.nodes.length + 1}`,
			key, kind, label,
			parentId: parent ? parent.id : null,
			depth: parent ? parent.depth + 1 : 0,
			children: [],
			added: 0, removed: 0, fileCount: 0, hunkCount: 0,
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

/** Top-level symbols per file, plus a stand-in for files with no outline. */
function collectConcepts(fileNodes, sources) {
	const concepts = [];
	for (const fileNode of fileNodes) {
		if (fileNode.kind !== 'file') continue;
		const path = fileNode.payload.path ?? fileNode.label;
		const loose = fileNode.children.filter((child) => child.kind === 'hunk');
		for (const child of fileNode.children) {
			if (child.kind !== 'symbol') continue;
			concepts.push({
				source: child,
				path,
				fileKey: fileNode.key,
				excluded: fileNode.payload.excluded,
				body: bodyOf(sources, path, child.payload.start, child.payload.end),
				fileText: sources.get(path) ?? '',
				moduleScope: child.payload.symbolKind === 'module',
			});
		}
		if (loose.length) {
			// A file with no parsable outline still needs one home for its hunks.
			concepts.push({
				source: null, looseHunks: loose, path,
				fileKey: fileNode.key, excluded: fileNode.payload.excluded,
				body: '', fileText: sources.get(path) ?? '', moduleScope: false,
				label: path.split('/').pop(), status: fileNode.payload.status,
			});
		}
	}
	return concepts;
}

/**
 * Most-depended-upon first: a name other concepts mention is defined earlier.
 * Tokenising each body once is linear; testing every name against every body is
 * not, and on a 650-file diff that is thousands of concepts squared.
 */
function referrerCounts(concepts) {
	const counts = new Map();
	for (const concept of concepts) {
		const name = concept.source?.label;
		if (name && name.length > 2 && /^[A-Za-z_$][\w$]*$/.test(name)) counts.set(name, 0);
	}
	for (const concept of concepts) {
		const own = concept.source?.label;
		for (const token of new Set(concept.body.match(/[A-Za-z_$][\w$]*/g) ?? [])) {
			if (token === own || !counts.has(token)) continue;
			counts.set(token, counts.get(token) + 1);
		}
	}
	return counts;
}

function cloneSubtree(builder, source, parent, context) {
	const node = builder.add({
		key: source.key, parent, kind: source.kind, label: source.label,
		payload: source.payload,
	});
	if (source.kind === 'hunk') {
		node.added = source.added;
		node.removed = source.removed;
		node.hunkCount = 1;
		node.contentHash = sha(source.contentHash);
		return node;
	}
	if (context && source.kind === 'symbol' && source.payload.start) {
		const body = bodyOf(context.sources, context.path, source.payload.start, source.payload.end);
		const facts = endpointFacts({ symbolKind: source.payload.symbolKind, body, fileText: context.fileText });
		if (facts) {
			node.payload = { ...node.payload, facts, layer: context.layer };
			node.label = `${facts.verb} ${facts.route}`;
		}
	}
	for (const child of source.children) cloneSubtree(builder, child, node, context);
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

/** One depth-first sequence through the stages, hunks excluded. */
function assignSteps(root) {
	let step = 0;
	const order = [];
	const walk = (node) => {
		if (node.kind === 'hunk') return;
		if (node.kind !== 'root') {
			node.payload = { ...node.payload, step: ++step };
			order.push(node.id);
		}
		node.children.forEach(walk);
	};
	walk(root);
	root.payload.totalSteps = step;
	root.payload.stepOrder = order;
	return root;
}

/** Every route the change touches, wherever its decorator sits. */
function collectEndpoints(concepts, sources) {
	const found = [];
	const visit = (node, concept) => {
		if (node.kind === 'symbol' && node.payload.start) {
			const body = bodyOf(sources, concept.path, node.payload.start, node.payload.end);
			const facts = endpointFacts({ symbolKind: node.payload.symbolKind, body, fileText: concept.fileText });
			if (facts) found.push({ ...facts, path: concept.path, symbol: node.label });
		}
		node.children?.forEach((child) => visit(child, concept));
	};
	for (const concept of concepts) if (concept.source) visit(concept.source, concept);
	return found.sort((a, b) => a.route.localeCompare(b.route) || a.verb.localeCompare(b.verb));
}

export function buildLayeredTree(fileTree, scope) {
	const builder = new Builder();
	const concepts = collectConcepts(fileTree.nodes, fileTree.sources);
	const counts = referrerCounts(concepts);

	for (const concept of concepts) {
		concept.layer = concept.excluded
			? 'other'
			: concept.moduleScope
				? 'imports'
				: classifyConcept({
				path: concept.path,
				symbolKind: concept.source?.payload.symbolKind ?? '',
				body: concept.body,
				fileText: concept.fileText,
			  });
		concept.facts = concept.source
			? endpointFacts({
				symbolKind: concept.source.payload.symbolKind,
				body: concept.body,
				fileText: concept.fileText,
			})
			: null;
		concept.weight = counts.get(concept.source?.label) ?? 0;
	}

	const root = builder.add({
		key: 'overview', parent: null, kind: 'root',
		label: scope.prTitle ?? `${scope.baseRef} → ${scope.headRef}`,
		payload: {
			...fileTree.root.payload,
			entryPoints: collectEndpoints(concepts, fileTree.sources),
		},
	});

	for (const layerId of LAYER_IDS) {
		const inLayer = concepts.filter((concept) => concept.layer === layerId);
		if (!inLayer.length) continue;

		inLayer.sort((a, b) => {
			if (a.moduleScope !== b.moduleScope) return a.moduleScope ? 1 : -1;
			if (layerId === 'entry' && a.facts && b.facts) return a.facts.route.localeCompare(b.facts.route);
			if (layerId !== 'tests' && a.weight !== b.weight) return b.weight - a.weight;
			if (a.path !== b.path) return a.path.localeCompare(b.path);
			return (a.source?.payload.start ?? 0) - (b.source?.payload.start ?? 0);
		});

		const meta = layerMeta(layerId);
		const layerNode = builder.add({
			key: `layer|${layerId}`, parent: root, kind: 'layer', label: meta.title,
			payload: { layer: layerId, blurb: meta.blurb },
		});

		for (const concept of inLayer) {
			if (concept.source) {
				const node = cloneSubtree(builder, concept.source, layerNode, {
					sources: fileTree.sources, path: concept.path,
					fileText: concept.fileText, layer: layerId,
				});
				node.payload = {
					...node.payload, layer: layerId, facts: concept.facts,
					fileKey: concept.fileKey, isConcept: true,
				};
				if (concept.facts) node.label = `${concept.facts.verb} ${concept.facts.route}`;
				else if (concept.moduleScope) node.label = `imports and top level · ${concept.path.split('/').pop()}`;
			} else {
				const node = builder.add({
					key: `file|${concept.path}`, parent: layerNode, kind: 'symbol',
					label: concept.label,
					payload: {
						path: concept.path, layer: layerId, isConcept: true, fileKey: concept.fileKey,
						symbolKind: concept.status ?? 'file', facts: null,
					},
				});
				for (const hunk of concept.looseHunks) cloneSubtree(builder, hunk, node);
			}
		}
	}

	finalise(root);
	assignSteps(root);
	root.payload.layerCounts = Object.fromEntries(
		root.children.map((layer) => [layer.payload.layer, { nodes: layer.children.length, added: layer.added, removed: layer.removed }]),
	);
	return { root, nodes: builder.nodes };
}
