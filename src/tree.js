import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { parsePatch, hunkNewSpan, hunkOldSpan, hunkText } from './diff.js';
import { outline, supportsOutline } from './structure.js';
import { readBatch, commitLog } from './git.js';

const DEFAULT_EXCLUDES = [
	'**/pnpm-lock.yaml', '**/package-lock.json', '**/yarn.lock', '**/bun.lockb', '**/Cargo.lock',
	'**/*.snap', '**/*.min.js', '**/*.map', '**/dist/**', '**/build/**', '**/.next/**',
	'**/*.generated.*', '**/generated/**', '**/__snapshots__/**',
];

/** Imports, top-level constants and anything between declarations live here. */
const MODULE_SCOPE = { name: '(module scope)', kind: 'module', start: 1, end: Number.MAX_SAFE_INTEGER, exported: false, children: [] };

/** Past this many files, outlines are computed only for the largest changes. */
const MAX_OUTLINE_FILES = 800;

const WORKSPACE_DIRS = new Set(['packages', 'apps', 'libs', 'crates', 'services', 'modules', 'plugins']);

function globToRegExp(pattern) {
	let source = '';
	for (let i = 0; i < pattern.length; i++) {
		const char = pattern[i];
		if (char === '*') {
			if (pattern[i + 1] === '*') {
				source += pattern[i + 2] === '/' ? '(?:.*/)?' : '.*';
				i += pattern[i + 2] === '/' ? 2 : 1;
			} else {
				source += '[^/]*';
			}
		} else if (char === '?') source += '[^/]';
		else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	}
	return new RegExp(`^${source}$`);
}

export function buildMatcher(repoRoot) {
	const patterns = [...DEFAULT_EXCLUDES];
	const configPath = join(repoRoot, '.unfoldignore');
	if (existsSync(configPath)) {
		for (const raw of readFileSync(configPath, 'utf8').split('\n')) {
			const line = raw.trim();
			if (line && !line.startsWith('#')) patterns.push(line);
		}
	}
	const rules = patterns.map((pattern) => ({
		negated: pattern.startsWith('!'),
		regex: globToRegExp(pattern.replace(/^!/, '')),
	}));
	return (path) => {
		let excluded = false;
		for (const rule of rules) if (rule.regex.test(path)) excluded = !rule.negated;
		return excluded;
	};
}

function groupKeyFor(path) {
	const segments = path.split('/');
	if (segments.length === 1) return '(repository root)';
	if (WORKSPACE_DIRS.has(segments[0])) {
		if (segments[1]?.startsWith('@') && segments.length > 2) return segments.slice(0, 3).join('/');
		return segments.slice(0, 2).join('/');
	}
	return segments[0];
}

function sha(...parts) {
	const hash = createHash('sha256');
	for (const part of parts) hash.update(String(part));
	return hash.digest('hex').slice(0, 16);
}

/** Every symbol in the file, changed or not, as a flat name index. */
function flattenOutline(symbols, out = []) {
	for (const symbol of symbols) {
		out.push({ name: symbol.name, kind: symbol.kind, start: symbol.start, end: symbol.end });
		flattenOutline(symbol.children, out);
	}
	return out;
}

function chainFor(symbols, start, end) {
	for (const symbol of symbols) {
		if (symbol.start <= start && end <= symbol.end) {
			return [symbol, ...chainFor(symbol.children, start, end)];
		}
	}
	return [];
}

class TreeBuilder {
	constructor() {
		this.nodes = [];
		this.byKey = new Map();
	}

	add({ key, parent, kind, label, ...rest }) {
		const existing = this.byKey.get(key);
		if (existing) return existing;
		const node = {
			id: String(this.nodes.length + 1),
			key, kind, label,
			parentId: parent ? parent.id : null,
			depth: parent ? parent.depth + 1 : 0,
			children: [],
			added: 0, removed: 0, fileCount: 0, hunkCount: 0,
			...rest,
		};
		this.nodes.push(node);
		this.byKey.set(key, node);
		if (parent) parent.children.push(node);
		return node;
	}
}

/** Children of files and symbols read in source order, not first-touch order. */
function sortBySource(node) {
	if (node.kind === 'file' || node.kind === 'symbol') {
		node.children.sort((a, b) => {
			const ka = a.kind === 'symbol' ? a.payload.start : a.payload.from;
			const kb = b.kind === 'symbol' ? b.payload.start : b.payload.from;
			return (ka ?? 0) - (kb ?? 0);
		});
	}
	node.children.forEach(sortBySource);
}

/** Roll counts and a content hash up from the leaves. */
function finalise(node) {
	if (node.children.length === 0) {
		node.contentHash = node.contentHash ?? sha(node.key);
		return node;
	}
	const hashes = [];
	for (const child of node.children) {
		finalise(child);
		node.added += child.added;
		node.removed += child.removed;
		node.hunkCount += child.hunkCount;
		node.fileCount += child.kind === 'file' ? 1 : child.fileCount;
		hashes.push(child.contentHash);
	}
	node.contentHash = sha(node.key, ...hashes);
	return node;
}

export function buildTree(scope, { excludeMatcher, maxOutlineFiles = MAX_OUTLINE_FILES } = {}) {
	const files = parsePatch(scope.patch);
	const isExcluded = excludeMatcher ?? buildMatcher(scope.cwd);
	const builder = new TreeBuilder();

	// Decide which files get an outline, then fetch all their blobs in one pass.
	const outlineCandidates = files
		.filter((file) => !file.binary && !isExcluded(file.path) && file.hunks.length && supportsOutline(file.path))
		.sort((a, b) => b.added + b.removed - (a.added + a.removed))
		.slice(0, maxOutlineFiles);
	const wanted = new Set(outlineCandidates.map((file) => file.path));
	const headPaths = outlineCandidates.filter((file) => file.status !== 'deleted').map((file) => file.path);
	const basePaths = outlineCandidates.filter((file) => file.status === 'deleted').map((file) => file.oldPath ?? file.path);
	const headSources = readBatch(scope, scope.headSha, headPaths);
	const baseSources = readBatch(scope, scope.baseSha, basePaths);
	const outlineSkipped = files.length - outlineCandidates.length;

	const rootLabel = scope.prTitle ?? `${scope.baseRef} → ${scope.headRef}`;
	const root = builder.add({
		key: 'root', parent: null, kind: 'root', label: rootLabel,
		payload: {
			scopeKind: scope.scopeKind,
			baseRef: scope.baseRef, headRef: scope.headRef,
			baseSha: scope.baseSha, headSha: scope.headSha,
			prNumber: scope.prNumber ?? null, prUrl: scope.prUrl ?? null,
			prTitle: scope.prTitle ?? null, prBody: scope.prBody ?? null,
			prAuthor: scope.prAuthor ?? null,
			commits: commitLog(scope).trim().split('\n').filter(Boolean).slice(0, 40),
			skipped: scope.skipped ?? [],
			outlineSkipped: 0,
		},
	});

	const sortedFiles = [...files].sort((a, b) => {
		const ea = isExcluded(a.path) ? 1 : 0;
		const eb = isExcluded(b.path) ? 1 : 0;
		if (ea !== eb) return ea - eb;
		return a.path.localeCompare(b.path);
	});

	for (const file of sortedFiles) {
		const excluded = isExcluded(file.path);
		const groupKey = excluded ? 'excluded' : groupKeyFor(file.path);
		const group = builder.add({
			key: `group|${groupKey}`, parent: root, kind: 'group',
			label: excluded ? 'Excluded from analysis' : groupKey,
			payload: { excluded },
		});

		const label = !excluded && file.path.startsWith(`${groupKey}/`)
			? file.path.slice(groupKey.length + 1)
			: file.path;
		const fileNode = builder.add({
			key: `file|${file.path}`, parent: group, kind: 'file', label,
			payload: {
				status: file.status, binary: file.binary, truncated: file.truncated,
				oldPath: file.oldPath, newPath: file.newPath,
				language: extname(file.path).replace('.', '') || 'text',
				excluded,
			},
		});

		if (file.binary || excluded || file.hunks.length === 0) {
			// Counts come from the hunks in finalise. Setting them here as well
			// makes every excluded file count twice in the totals.
			fileNode.contentHash = sha(file.path, file.added, file.removed, file.hunks.length);
			// Hunks stay reachable so nothing is hidden, but they are not expanded by default.
			attachHunks(builder, fileNode, file, []);
			continue;
		}

		const useOldSide = file.status === 'deleted';
		const source = wanted.has(file.path)
			? (useOldSide ? baseSources.get(file.oldPath ?? file.path) : headSources.get(file.path))
			: null;
		const parsed = source == null ? null : outline(file.path, source);
		attachHunks(builder, fileNode, file, parsed?.symbols ?? [], useOldSide);
		fileNode.payload.imports = parsed?.imports ?? [];
		fileNode.payload.symbolIndex = flattenOutline(parsed?.symbols ?? []);
		fileNode.payload.hasOutline = Boolean(parsed?.symbols?.length);
		fileNode.payload.path = file.path;
	}

	root.payload.outlineSkipped = outlineSkipped;
	sortBySource(root);
	finalise(root);
	const sources = new Map([...headSources, ...baseSources]);
	return { root, nodes: builder.nodes, files, sources };
}

/**
 * A hunk that spans several symbols is split at the symbol boundaries, so every
 * symbol node carries exactly the diff lines that touch it. Context-only runs
 * are folded into the neighbouring change rather than becoming their own node.
 */
function segmentHunk(hunk, symbols, side) {
	const segments = [];
	let anchor = side === 'old' ? hunk.oldStart : hunk.newStart;
	for (const line of hunk.lines) {
		const own = side === 'old' ? line.o : line.n;
		if (own !== null) anchor = own;
		const chain = chainFor(symbols, anchor, anchor);
		const chainKey = chain.map((symbol) => symbol.name).join('.');
		const last = segments[segments.length - 1];
		if (last && last.chainKey === chainKey) last.lines.push(line);
		else segments.push({ chainKey, chain, lines: [line] });
	}

	const changed = (segment) => segment.lines.some((line) => line.t !== ' ');
	const merged = [];
	for (const segment of segments) {
		if (changed(segment)) {
			merged.push(segment);
			continue;
		}
		// Context-only run: keep it with a neighbour so it stays visible in one place.
		const previous = merged[merged.length - 1];
		if (previous) previous.lines.push(...segment.lines);
		else segments[segments.indexOf(segment) + 1]?.lines.unshift(...segment.lines);
	}
	return merged.length ? merged : [{ chainKey: '', chain: [], lines: hunk.lines }];
}

function attachHunks(builder, fileNode, file, symbols, useOldSide = false) {
	const side = useOldSide ? 'old' : 'new';
	for (const hunk of file.hunks) {
		const segments = symbols.length
			? segmentHunk(hunk, symbols, side)
			: [{ chainKey: '', chain: [], lines: hunk.lines }];

		segments.forEach((segment, segmentIndex) => {
			let parent = fileNode;
			const pathParts = [];
			const chain = segment.chain.length || symbols.length === 0
				? segment.chain
				: [MODULE_SCOPE];
			for (const symbol of chain) {
				pathParts.push(symbol.name);
				parent = builder.add({
					key: `sym|${file.path}|${pathParts.join('.')}`,
					parent, kind: 'symbol', label: symbol.name,
					payload: {
						path: file.path, symbolPath: pathParts.join('.'), symbolKind: symbol.kind,
						start: symbol.start, end: symbol.end, exported: symbol.exported, side,
					},
				});
			}

			const numbered = segment.lines.filter((line) => (side === 'old' ? line.o : line.n) !== null);
			const first = numbered[0];
			const last = numbered[numbered.length - 1];
			const from = first ? (side === 'old' ? first.o : first.n) : hunk.newStart;
			const to = last ? (side === 'old' ? last.o : last.n) : hunk.newStart;
			const added = segment.lines.filter((line) => line.t === '+').length;
			const removed = segment.lines.filter((line) => line.t === '-').length;

			const hunkNode = builder.add({
				key: `hunk|${file.path}|${hunk.oldStart}|${hunk.index}|${segmentIndex}`,
				parent, kind: 'hunk',
				label: from === to ? `line ${from}` : `lines ${from}–${to}`,
				payload: {
					path: file.path, oldPath: file.oldPath, newPath: file.newPath,
					oldStart: hunk.oldStart, newStart: hunk.newStart,
					hunkIndex: hunk.index, segmentIndex, side, from, to,
					header: hunk.header, lines: segment.lines,
					language: fileNode.payload.language,
				},
			});
			hunkNode.added = added;
			hunkNode.removed = removed;
			hunkNode.hunkCount = 1;
			hunkNode.contentHash = sha(
				file.path, hunk.oldStart, segmentIndex,
				segment.lines.map((line) => `${line.t}${line.s}`).join('\n'),
			);
		});
	}
}
