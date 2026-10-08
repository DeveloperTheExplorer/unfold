import { resolveScope, scopeKey } from './git.js';
import { buildTree } from './tree.js';
import { buildFeatureTree } from './feature-tree.js';
import { symbolContext, fileContext } from './context.js';
import { openDb } from './db.js';
import { Explainer } from './explain.js';

/** Everything a run needs, wired once and shared by the CLI and the server. */
export function createRun(options = {}) {
	const scope = resolveScope(options);
	const fileTree = buildTree(scope);
	const featureTree = buildFeatureTree(fileTree, scope);
	// A source may occur in several blocks because its effect must be assessed in
	// each flow. Block keys therefore remain distinct from file-tree keys.
	const nodes = [...featureTree.nodes, ...fileTree.nodes];
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const byKey = new Map(fileTree.nodes.map((node) => [node.key, node]));
	const index = {
		root: featureTree.root, fileRoot: fileTree.root,
		nodes, byId, byKey,
	};

	const fileNodeFor = (node) => {
		let current = node;
		while (current) {
			if (current.kind === 'file') return current;
			if (current.payload?.fileKey) return byKey.get(current.payload.fileKey) ?? null;
			current = current.parentId ? byId.get(current.parentId) : null;
		}
		return null;
	};

	const contextFor = (node) => {
		if (node.kind === 'file') return fileContext(scope, node);
		if (node.kind === 'hunk') {
			const fileNode = fileNodeFor(node);
			let owner = node.parentId ? byId.get(node.parentId) : null;
			while (owner && owner.kind !== 'symbol') owner = owner.parentId ? byId.get(owner.parentId) : null;
			return owner && fileNode ? symbolContext(scope, owner, fileNode) : fileNode ? fileContext(scope, fileNode) : null;
		}
		if (node.kind !== 'symbol') return null;
		// A stand-in for a file with no outline has no symbol range to read.
		if (!node.payload?.start) {
			const fileNode = fileNodeFor(node);
			return fileNode ? fileContext(scope, fileNode) : null;
		}
		return symbolContext(scope, node, fileNodeFor(node));
	};

	const db = openDb(scope.cwd);
	const explainer = new Explainer({
		db, scope, index, contextFor,
		agent: options.agent ?? 'codex',
		model: options.model,
		concurrency: options.concurrency ?? 3,
		tools: options.tools ?? 'synthesis',
	});

	return { scope, scopeKey: scopeKey(scope), index, db, explainer, contextFor, fileNodeFor };
}

/** The tree without line payloads: what the browser needs to draw the spine. */
export function treeSummary(root) {
	// Only the fields the tree view actually draws or filters on: on a 650-file
	// diff every extra field costs hundreds of kilobytes over the wire.
	const shape = (node) => ({
		id: node.id,
		key: node.key,
		kind: node.kind,
		label: node.label,
		added: node.added,
		removed: node.removed,
		symbolKind: node.payload?.symbolKind ?? null,
		layer: node.payload?.layer ?? undefined,
		blurb: node.payload?.blurb ?? undefined,
		blockType: node.payload?.blockType ?? undefined,
		shared: node.payload?.shared || undefined,
		sharedCount: node.payload?.sharedCount || undefined,
		appendix: node.payload?.appendix || undefined,
		step: node.payload?.step ?? undefined,
		endpoint: node.payload?.facts ? true : undefined,
		excluded: node.payload?.excluded || undefined,
		path: node.payload?.path ?? undefined,
		children: node.children.map(shape),
	});
	return shape(root);
}
