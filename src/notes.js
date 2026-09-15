import { execFileSync } from 'node:child_process';
import { gitTry } from './git.js';
import { listNotes, updateNote } from './db.js';

/** One note store, three exits: the local agent, a GitHub review, or a file. */

function escapeXml(text) {
	return String(text ?? '')
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

const lineRange = (note) =>
	note.start_line === note.end_line ? `${note.start_line}` : `${note.start_line}-${note.end_line}`;

/** XML, because agents parse it more reliably than prose and it keeps the code inline. */
export function toXml(notes) {
	const parts = ['<review-notes>'];
	for (const note of notes) {
		parts.push(
			`  <note id="${note.id}" file="${escapeXml(note.path)}" lines="${lineRange(note)}" side="${note.side}" status="${note.status}">`,
		);
		if (note.code) parts.push(`    <code><![CDATA[\n${note.code}\n]]></code>`);
		parts.push(`    <comment author="user">${escapeXml(note.body)}</comment>`);
		for (const reply of note.replies ?? []) {
			parts.push(`    <comment author="${reply.author}">${escapeXml(reply.body)}</comment>`);
		}
		parts.push('  </note>');
	}
	parts.push('</review-notes>');
	return parts.join('\n');
}

export function toMarkdown(notes, { title } = {}) {
	const lines = [`# Review notes${title ? ` — ${title}` : ''}`, ''];
	let currentPath = null;
	for (const note of notes) {
		if (note.path !== currentPath) {
			currentPath = note.path;
			lines.push(`## \`${note.path}\``, '');
		}
		const marker = note.status === 'resolved' ? '[resolved]' : '';
		lines.push(`- **L${lineRange(note)}** ${marker} ${note.body}  <!-- ${note.id.slice(0, 8)} -->`);
		if (note.code) {
			lines.push('', '  ```', ...note.code.split('\n').map((line) => `  ${line}`), '  ```', '');
		}
		for (const reply of note.replies ?? []) {
			lines.push(`  - _${reply.author}_: ${reply.body}`);
		}
	}
	lines.push('');
	return lines.join('\n');
}

export function toJson(notes) {
	return JSON.stringify(
		notes.map((note) => ({
			id: note.id,
			file: note.path,
			side: note.side,
			startLine: note.start_line,
			endLine: note.end_line,
			status: note.status,
			body: note.body,
			code: note.code,
			postedUrl: note.posted_url,
			replies: (note.replies ?? []).map((reply) => ({ author: reply.author, body: reply.body })),
		})),
		null,
		2,
	);
}

export function exportNotes(notes, format, options = {}) {
	if (format === 'xml') return toXml(notes);
	if (format === 'md' || format === 'markdown') return toMarkdown(notes, options);
	return toJson(notes);
}

function originRepo(cwd) {
	const url = gitTry(['remote', 'get-url', 'origin'], { cwd })?.trim();
	if (!url) return null;
	const match = url.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?$/);
	return match ? { owner: match[1], repo: match[2] } : null;
}

function ghApi(args, body, cwd) {
	const out = execFileSync('gh', args, {
		cwd, input: body ? JSON.stringify(body) : undefined,
		encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
	});
	return out.trim() ? JSON.parse(out) : {};
}

/**
 * Posts notes as one pending-free review comment batch. GitHub rejects comments
 * on lines outside the diff, so a failed batch is retried one comment at a time
 * and the reviewer is told exactly which anchors GitHub refused.
 */
export function postToGitHub(db, scope, { notes, summary = '', dryRun = false }) {
	if (!scope.prNumber) throw new Error('This scope is not a pull request. Re-run with --pr <number> to post.');
	const repo = originRepo(scope.cwd);
	if (!repo) throw new Error('Could not read a github.com origin remote.');

	const postable = notes.filter((note) => note.status === 'open' && !note.posted_url);
	if (!postable.length) return { posted: 0, failed: [], skipped: notes.length, dryRun };

	const comments = postable.map((note) => {
		const comment = {
			path: note.path,
			line: note.end_line,
			side: note.side === 'deletions' ? 'LEFT' : 'RIGHT',
			body: note.body,
		};
		if (note.end_line > note.start_line) {
			comment.start_line = note.start_line;
			comment.start_side = comment.side;
		}
		return comment;
	});

	const endpoint = `repos/${repo.owner}/${repo.repo}/pulls/${scope.prNumber}/reviews`;
	if (dryRun) {
		return { dryRun: true, endpoint, payload: { event: 'COMMENT', body: summary, comments }, posted: 0, failed: [] };
	}

	try {
		const review = ghApi(
			['api', '--method', 'POST', endpoint, '--input', '-'],
			{ event: 'COMMENT', body: summary, comments },
			scope.cwd,
		);
		for (const note of postable) updateNote(db, note.id, { posted_url: review.html_url ?? `pr-${scope.prNumber}` });
		return { posted: postable.length, failed: [], url: review.html_url, dryRun: false };
	} catch (batchError) {
		// One bad anchor fails the whole batch, so fall back to per-comment posts.
		const commitId = scope.headSha;
		const failed = [];
		let posted = 0;
		for (const [offset, note] of postable.entries()) {
			try {
				const created = ghApi(
					['api', '--method', 'POST', `repos/${repo.owner}/${repo.repo}/pulls/${scope.prNumber}/comments`, '--input', '-'],
					{ ...comments[offset], commit_id: commitId },
					scope.cwd,
				);
				updateNote(db, note.id, { posted_url: created.html_url });
				posted++;
			} catch (singleError) {
				failed.push({
					id: note.id, path: note.path, line: note.end_line,
					reason: String(singleError.stderr ?? singleError.message).slice(0, 300),
				});
			}
		}
		if (!posted) {
			failed.unshift({ id: null, reason: `batch review failed: ${String(batchError.stderr ?? batchError.message).slice(0, 300)}` });
		}
		return { posted, failed, dryRun: false };
	}
}

export function collectNotes(db, scopeKey, status = 'all') {
	return listNotes(db, { scopeKey, status });
}
