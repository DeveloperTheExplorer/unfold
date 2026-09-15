import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BUFFER = 96 * 1024 * 1024;

export function git(args, opts = {}) {
	return execFileSync('git', args, {
		cwd: opts.cwd ?? process.cwd(),
		maxBuffer: MAX_BUFFER,
		encoding: opts.encoding ?? 'utf8',
		stdio: ['ignore', 'pipe', 'pipe'],
	});
}

/** Run git and return null instead of throwing, for probes. */
export function gitTry(args, opts = {}) {
	try {
		return git(args, opts);
	} catch {
		return null;
	}
}

export function repoRoot(cwd = process.cwd()) {
	const out = gitTry(['rev-parse', '--show-toplevel'], { cwd });
	if (!out) throw new Error('Not inside a git repository.');
	return out.trim();
}

/** origin/HEAD when the remote advertises one, else the first branch that exists. */
export function detectBase(cwd) {
	const symbolic = gitTry(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], { cwd });
	if (symbolic) return symbolic.trim().replace('refs/remotes/', '');
	for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
		if (gitTry(['rev-parse', '--verify', '--quiet', candidate], { cwd })) return candidate;
	}
	throw new Error('Could not detect a base ref. Pass --base <ref>.');
}

/** Refuses names git would read as options or that would break an arg list. */
function assertSafeRef(ref) {
	if (!/^[\w./+@^~-]+$/.test(ref) || ref.startsWith('-')) {
		throw new Error(`Refusing to use "${ref}" as a git ref.`);
	}
	return ref;
}

function mergeBase(a, b, cwd) {
	const out = gitTry(['merge-base', a, b], { cwd });
	// Unrelated histories: fall back to the base tip so the diff is still computable.
	return out ? out.trim() : gitTry(['rev-parse', a], { cwd })?.trim();
}

function isDirty(cwd) {
	return (gitTry(['status', '--porcelain', '--untracked-files=no'], { cwd }) ?? '').trim().length > 0;
}

const MAX_UNTRACKED_FILES = 60;
const MAX_UNTRACKED_BYTES = 256 * 1024;

function untrackedDiff(cwd) {
	const listed = gitTry(['ls-files', '--others', '--exclude-standard', '-z'], { cwd }) ?? '';
	const paths = listed.split('\0').filter(Boolean);
	const chunks = [];
	const skipped = [];
	for (const path of paths.slice(0, MAX_UNTRACKED_FILES)) {
		const abs = join(cwd, path);
		try {
			const { size } = statSync(abs);
			if (size > MAX_UNTRACKED_BYTES) {
				skipped.push(path);
				continue;
			}
		} catch {
			continue;
		}
		// --no-index exits 1 when files differ, which is the normal case here.
		try {
			git(['diff', '--no-index', '--no-color', '--', '/dev/null', path], { cwd });
		} catch (error) {
			if (error.stdout) chunks.push(error.stdout.toString());
		}
	}
	if (paths.length > MAX_UNTRACKED_FILES) skipped.push(`… ${paths.length - MAX_UNTRACKED_FILES} more untracked files`);
	return { patch: chunks.join(''), skipped };
}

function ghJson(args, cwd) {
	const out = execFileSync('gh', args, { cwd, maxBuffer: MAX_BUFFER, encoding: 'utf8' });
	return JSON.parse(out);
}

/**
 * Resolve every entry point (PR, explicit refs, branch, working tree) into one
 * shape: a base sha, a head sha or the working tree, and the patch text.
 */
export function resolveScope(opts = {}) {
	const cwd = repoRoot(opts.cwd);
	if (opts.pr) {
		const number = String(opts.pr).match(/(\d+)(?!.*\d)/)?.[1];
		if (!number) throw new Error(`Could not read a PR number from "${opts.pr}".`);
		const pr = ghJson(
			['pr', 'view', number, '--json', 'number,title,body,baseRefName,headRefName,headRefOid,url,author'],
			cwd,
		);
		git(['fetch', '--quiet', '--no-tags', '--force', 'origin', `pull/${number}/head:refs/unfold/pr-${number}`], { cwd });
		gitTry(['fetch', '--quiet', '--no-tags', 'origin', assertSafeRef(pr.baseRefName)], { cwd });
		const headSha = pr.headRefOid;
		const baseSha = mergeBase(`origin/${pr.baseRefName}`, headSha, cwd);
		return {
			cwd,
			scopeKind: 'pr',
			baseRef: `origin/${pr.baseRefName}`,
			headRef: pr.headRefName,
			baseSha,
			headSha,
			prNumber: pr.number,
			prTitle: pr.title,
			prBody: pr.body ?? '',
			prUrl: pr.url,
			prAuthor: pr.author?.login ?? null,
			patch: git(['diff', '--no-color', '-M', '--find-renames', baseSha, headSha], { cwd }),
			skipped: [],
		};
	}

	const baseRef = opts.base ?? detectBase(cwd);
	const baseTip = gitTry(['rev-parse', baseRef], { cwd })?.trim();
	if (!baseTip) throw new Error(`Base ref "${baseRef}" does not resolve.`);

	if (opts.head) {
		const headSha = gitTry(['rev-parse', opts.head], { cwd })?.trim();
		if (!headSha) throw new Error(`Head ref "${opts.head}" does not resolve.`);
		const baseSha = mergeBase(baseRef, headSha, cwd);
		return {
			cwd, scopeKind: 'range', baseRef, headRef: opts.head, baseSha, headSha,
			patch: git(['diff', '--no-color', '-M', baseSha, headSha], { cwd }), skipped: [],
		};
	}

	const headSha = gitTry(['rev-parse', 'HEAD'], { cwd })?.trim();
	const baseSha = mergeBase(baseRef, headSha, cwd);
	const branchName = gitTry(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd })?.trim() ?? 'HEAD';
	const dirty = opts.ref === 'work' || (opts.ref !== 'branch' && isDirty(cwd));

	if (dirty) {
		const { patch, skipped } = opts.untracked === false ? { patch: '', skipped: [] } : untrackedDiff(cwd);
		return {
			cwd, scopeKind: 'work', baseRef, headRef: branchName, baseSha, headSha: 'WORKTREE',
			patch: git(['diff', '--no-color', '-M', baseSha], { cwd }) + patch, skipped,
		};
	}
	return {
		cwd, scopeKind: 'branch', baseRef, headRef: branchName, baseSha, headSha,
		patch: git(['diff', '--no-color', '-M', baseSha, headSha], { cwd }), skipped: [],
	};
}

/** Stable across re-runs of the same scope, so notes and caches survive regeneration. */
export function scopeKey(scope) {
	return createHash('sha256')
		.update([scope.cwd, scope.scopeKind, scope.baseSha, scope.headSha, scope.prNumber ?? ''].join('\n'))
		.digest('hex')
		.slice(0, 16);
}

/** File content on the head side: from disk for the working tree, from the object store otherwise. */
export function readHead(scope, path) {
	if (scope.headSha === 'WORKTREE') {
		const abs = join(scope.cwd, path);
		return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
	}
	return gitTry(['show', `${scope.headSha}:${path}`], { cwd: scope.cwd });
}

export function readBase(scope, path) {
	return gitTry(['show', `${scope.baseSha}:${path}`], { cwd: scope.cwd });
}

/**
 * Blob contents for many paths in one subprocess. Reading a 650-file diff with
 * one `git show` per file costs ~30s; this does the same work in well under one.
 */
export function readBatch(scope, sha, paths) {
	const result = new Map();
	if (!paths.length) return result;

	if (sha === 'WORKTREE') {
		for (const path of paths) {
			const abs = join(scope.cwd, path);
			result.set(path, existsSync(abs) ? readFileSync(abs, 'utf8') : null);
		}
		return result;
	}

	// A newline is legal in a POSIX filename and would desync the request-to-reply
	// pairing for everything after it, so those paths are read one at a time.
	const awkward = paths.filter((path) => /[\n\r]/.test(path));
	const batchable = paths.filter((path) => !/[\n\r]/.test(path));
	for (const path of awkward) {
		result.set(path, gitTry(['show', `${sha}:${path}`], { cwd: scope.cwd }));
	}
	if (!batchable.length) return result;

	// `encoding` applies to stdin as well as stdout here, so the request has to be
	// a Buffer and the reply is left as one. A failure is a bug, not a missing file:
	// `--batch` reports missing objects in-stream and still exits zero.
	const request = Buffer.from(`${batchable.map((path) => `${sha}:${path}`).join('\n')}\n`, 'utf8');
	const out = execFileSync('git', ['cat-file', '--batch'], {
		cwd: scope.cwd, input: request, maxBuffer: 512 * 1024 * 1024,
	});

	let offset = 0;
	let index = 0;
	while (offset < out.length && index < batchable.length) {
		const newline = out.indexOf(10, offset);
		if (newline === -1) break;
		const header = out.toString('utf8', offset, newline);
		offset = newline + 1;
		if (header.endsWith(' missing')) {
			result.set(batchable[index++], null);
			continue;
		}
		const size = Number(header.split(' ')[2]);
		if (!Number.isFinite(size)) break;
		result.set(batchable[index++], out.toString('utf8', offset, offset + size));
		offset += size + 1;
	}
	for (const path of paths) if (!result.has(path)) result.set(path, null);
	return result;
}

export function readHeadBatch(scope, paths) {
	return readBatch(scope, scope.headSha, paths);
}

export function commitLog(scope) {
	if (scope.headSha === 'WORKTREE' || scope.scopeKind === 'work') {
		return gitTry(['log', '--oneline', '--no-decorate', `${scope.baseSha}..HEAD`], { cwd: scope.cwd }) ?? '';
	}
	return gitTry(['log', '--oneline', '--no-decorate', `${scope.baseSha}..${scope.headSha}`], { cwd: scope.cwd }) ?? '';
}
