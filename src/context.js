import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, extname } from 'node:path';
import { readHead, gitTry, readBatch } from './git.js';

/**
 * The code that already existed. A diff tells you what changed; this tells you
 * what the change is standing on. All of it is derived from ripgrep and the
 * file's own import list, so nothing here is a model's guess.
 */

const EXCLUDE_GLOBS = [
	'!**/node_modules/**', '!**/dist/**', '!**/build/**', '!**/.git/**',
	'!**/coverage/**', '!**/*.map', '!**/*.min.js', '!**/.turbo/**',
];

const TEST_PATTERN = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;

/** Names too common to search for usefully. */
const STOPLIST = new Set([
	'get', 'set', 'run', 'data', 'value', 'result', 'options', 'props', 'state',
	'index', 'default', 'main', 'init', 'render', 'handler', 'config', 'context',
]);

const cache = new Map();
const textCache = new Map();
const packageRootCache = new Map();

const CODE_GLOB = '*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,vue}';

function fileText(scope, path) {
	if (!textCache.has(path)) textCache.set(path, readHead(scope, path));
	return textCache.get(path);
}

/**
 * Nearest package boundary above a file. Searching one package instead of a
 * whole monorepo is the difference between 200ms and 3s, and a symbol's callers
 * are almost always inside its own package.
 */
function packageRootFor(scope, path) {
	if (packageRootCache.has(path)) return packageRootCache.get(path);
	let dir = dirname(path);
	let found = '.';
	while (dir && dir !== '.' && dir !== '/') {
		if (existsAtHead(scope, `${dir}/package.json`)) { found = dir; break; }
		dir = dirname(dir);
	}
	packageRootCache.set(path, found);
	return found;
}

export function rgSearch(pattern, { cwd, max = 24, perFile = 3, globs = [], paths = ['.'] } = {}) {
	// ripgrep resolves globs last-match-wins, so every exclusion has to come
	// after every inclusion or a positive glob silently re-adds the file.
	const ordered = [
		...globs.filter((glob) => !glob.startsWith('!')),
		...EXCLUDE_GLOBS,
		...globs.filter((glob) => glob.startsWith('!')),
	];
	const args = [
		'--line-number', '--no-heading', '--color', 'never', '--max-count', String(perFile),
		...ordered.flatMap((glob) => ['-g', glob]),
		'-e', pattern, '--', ...paths,
	];
	let out;
	try {
		out = execFileSync('rg', args, { cwd, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000 });
	} catch (error) {
		// rg exits 1 on no matches, 2 on partial errors; both can carry usable stdout.
		out = error.stdout ? error.stdout.toString() : '';
	}
	const hits = [];
	for (const line of out.split('\n')) {
		if (!line) continue;
		const match = line.match(/^([^:]+):(\d+):(.*)$/);
		if (!match) continue;
		hits.push({ path: match[1].replace(/^\.\//, ''), line: Number(match[2]), text: match[3].trim().slice(0, 240) });
		if (hits.length >= max) break;
	}
	return hits;
}

function existsAtHead(scope, path) {
	if (scope.headSha === 'WORKTREE') return existsSync(join(scope.cwd, path));
	return gitTry(['cat-file', '-e', `${scope.headSha}:${path}`], { cwd: scope.cwd }) !== null;
}

const RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.mts', '.d.ts', '.js', '.jsx', '.mjs', '.vue', '/index.ts', '/index.tsx', '/index.js', '/index.vue'];

function resolveRelative(scope, fromPath, specifier) {
	const base = join(dirname(fromPath), specifier).replace(/\\/g, '/').replace(/^\.\//, '');
	for (const suffix of RESOLVE_SUFFIXES) {
		const candidate = (base + suffix).replace(/\/\.\//g, '/');
		if (extname(candidate) && existsAtHead(scope, candidate)) return candidate;
	}
	return null;
}

let workspaceIndex = null;

/**
 * Package name to directory, read from the workspace's own package.json files.
 * Without this, resolving one bare import means scanning the whole monorepo.
 */
function workspacePackages(scope) {
	if (workspaceIndex) return workspaceIndex;
	workspaceIndex = [];
	const listed = gitTry(['ls-files', '-z', '*package.json'], { cwd: scope.cwd }) ?? '';
	const manifests = listed.split('\0').filter((path) => path && !path.includes('node_modules/'));
	const contents = readBatch(scope, scope.headSha, manifests);
	for (const path of manifests) {
		const text = contents.get(path);
		if (!text) continue;
		try {
			const name = JSON.parse(text).name;
			if (name) workspaceIndex.push({ name, dir: dirname(path) === '.' ? '.' : dirname(path) });
		} catch {
			// A package.json we cannot parse is not worth failing the whole index over.
		}
	}
	workspaceIndex.sort((a, b) => b.name.length - a.name.length);
	return workspaceIndex;
}

function packageDirFor(scope, specifier) {
	for (const entry of workspacePackages(scope)) {
		if (specifier === entry.name || specifier.startsWith(`${entry.name}/`)) return entry.dir;
	}
	return null;
}

const declarationCache = new Map();

function findDeclaration(scope, name, paths) {
	const key = `${paths.join(',')}|${name}`;
	if (declarationCache.has(key)) return declarationCache.get(key);
	const [hit] = rgSearch(DECLARATION_PATTERN(name), {
		cwd: scope.cwd, max: 1, perFile: 1, paths, globs: [CODE_GLOB],
	});
	declarationCache.set(key, hit ?? null);
	return hit ?? null;
}

const DECLARATION_PATTERN = (name) =>
	`export\\s+(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:default\\s+)?(?:function|class|const|let|var|interface|type|enum)\\s+${name}\\b`;

/** Where an identifier used in the changed lines actually comes from. */
function resolveDependencies(scope, filePath, imports, identifiers) {
	const found = [];
	for (const entry of imports) {
		for (const name of entry.names) {
			if (!identifiers.has(name.local)) continue;
			const record = {
				local: name.local, imported: name.imported, typeOnly: name.typeOnly,
				module: entry.module, resolved: null, declaration: null,
			};
			if (entry.module.startsWith('.')) {
				record.resolved = resolveRelative(scope, filePath, entry.module);
				if (record.resolved && name.imported !== '*' && name.imported !== 'default') {
					record.declaration = findDeclaration(scope, name.imported, [record.resolved]);
				}
			} else if (name.imported !== '*' && name.imported !== 'default' && !STOPLIST.has(name.imported)) {
				const packageDir = packageDirFor(scope, entry.module);
				if (packageDir) {
					const hit = findDeclaration(scope, name.imported, [packageDir]);
					if (hit) {
						record.resolved = hit.path;
						record.declaration = hit;
						record.packageDir = packageDir;
					} else {
						record.packageDir = packageDir;
					}
				}
			}
			found.push(record);
			if (found.length >= 25) return found;
		}
	}
	return found;
}

function changedLineNumbers(node) {
	const lines = new Set();
	const walk = (current) => {
		if (current.kind === 'hunk') {
			for (const line of current.payload.lines) {
				if (line.t !== ' ' && line.n !== null) lines.add(line.n);
			}
		}
		current.children?.forEach(walk);
	};
	walk(node);
	return lines;
}

function changedIdentifiers(node) {
	const identifiers = new Set();
	const walk = (current) => {
		if (current.kind === 'hunk') {
			for (const line of current.payload.lines) {
				if (line.t === ' ') continue;
				for (const match of line.s.matchAll(/[A-Za-z_$][\w$]*/g)) identifiers.add(match[0]);
			}
		}
		current.children?.forEach(walk);
	};
	walk(node);
	return identifiers;
}

/** Same-file declarations the changed lines lean on, from the file's own outline. */
function localReferences(fileNode, identifiers, node) {
	const index = fileNode?.payload?.symbolIndex ?? [];
	const own = node.payload.symbolPath?.split('.') ?? [];
	return index
		.filter((symbol) => identifiers.has(symbol.name) && !own.includes(symbol.name))
		.slice(0, 15);
}

/**
 * The full current body of a changed symbol, with the changed lines marked.
 * This is the cheapest and highest-value context there is: the parts of the
 * function the diff did not show you.
 */
export function symbolSource(scope, node) {
	const { path, start, end } = node.payload;
	const text = fileText(scope, path);
	if (text == null) return null;
	const all = text.split('\n');
	const last = Math.min(end, all.length);
	const changed = changedLineNumbers(node);
	const lines = [];
	for (let n = start; n <= last; n++) {
		lines.push({ n, s: all[n - 1] ?? '', changed: changed.has(n) });
	}
	return { path, start, end: last, lines, totalLines: all.length };
}

export function symbolContext(scope, node, fileNode) {
	if (cache.has(node.key)) return cache.get(node.key);
	const filePath = node.payload.path;
	const memberKinds = new Set(['method', 'accessor', 'property']);
	const blockKinds = new Set(['module', 'describe', 'it', 'test', 'suite', 'context', 'block']);
	// A method's callers are found through its class; a test block has none worth listing.
	const owner = node.payload.symbolPath?.split('.') ?? [node.label];
	const name = memberKinds.has(node.payload.symbolKind) && owner.length > 1 ? owner[0] : node.label;
	const searchable =
		!blockKinds.has(node.payload.symbolKind) &&
		name.length >= 3 && /^[A-Za-z_$][\w$]*$/.test(name) && !STOPLIST.has(name);

	const scopeRoot = node.searchWholeRepo ? '.' : packageRootFor(scope, filePath);
	const callers = searchable
		? rgSearch(`\\b${name}\\b`, {
			cwd: scope.cwd, max: 24, perFile: 2,
			globs: [`!${filePath}`, CODE_GLOB], paths: [scopeRoot],
		})
		: [];

	const identifiers = changedIdentifiers(node);
	// The caller search excludes the declaring file, so look inside it separately.
	const sameFile = searchable
		? rgSearch(`\\b${name}\\b`, { cwd: scope.cwd, max: 12, perFile: 12, paths: [filePath] })
			.filter((hit) => hit.line < node.payload.start || hit.line > node.payload.end)
		: [];

	const result = {
		source: symbolSource(scope, node),
		callers: callers.filter((hit) => !TEST_PATTERN.test(hit.path)).slice(0, 12),
		tests: callers.filter((hit) => TEST_PATTERN.test(hit.path)).slice(0, 8),
		dependencies: resolveDependencies(scope, filePath, fileNode?.payload?.imports ?? [], identifiers),
		localReferences: localReferences(fileNode, identifiers, node),
		sameFile,
		searchedIn: scopeRoot,
		searchedFor: name,
		searchable,
	};
	cache.set(node.key, result);
	return result;
}

export function fileContext(scope, fileNode) {
	if (cache.has(fileNode.key)) return cache.get(fileNode.key);
	const path = fileNode.payload.path ?? fileNode.payload.newPath ?? fileNode.label;
	const stem = path.replace(/\.[cm]?[jt]sx?$|\.vue$/, '').split('/').pop();
	const importers = stem && stem !== 'index'
		? rgSearch(`from\\s+['"][^'"]*${stem}['"]`, { cwd: scope.cwd, max: 20, perFile: 2, globs: [`!${path}`] })
		: [];
	const result = {
		importers: importers.filter((hit) => !TEST_PATTERN.test(hit.path)).slice(0, 12),
		tests: importers.filter((hit) => TEST_PATTERN.test(hit.path)).slice(0, 6),
		siblings: [],
	};
	cache.set(fileNode.key, result);
	return result;
}

export function clearContextCache() {
	cache.clear();
	textCache.clear();
	declarationCache.clear();
	workspaceIndex = null;
}
