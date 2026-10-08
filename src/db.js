import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';

/**
 * Explanations, independent review runs, and reviewer notes outlive a run. The
 * tree itself is cheap to rebuild.
 */

export function databaseFile(repoRoot) {
	// In a linked worktree `.git` is a pointer file, not a directory. Let Git
	// resolve the real per-worktree metadata path so Unfold works in both shapes.
	try {
		const gitDir = execFileSync(
			'git', ['rev-parse', '--absolute-git-dir'],
			{ cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
		return join(gitDir, 'unfold', 'unfold.sqlite');
	} catch {
		return join(repoRoot, '.git', 'unfold', 'unfold.sqlite');
	}
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS explanation (
  node_key     TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  mode         TEXT NOT NULL,
  body         TEXT NOT NULL,
  model        TEXT,
  cost_usd     REAL,
  duration_ms  INTEGER,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (node_key, content_hash, mode)
);

CREATE TABLE IF NOT EXISTS note (
  id           TEXT PRIMARY KEY,
  scope_key    TEXT NOT NULL,
  node_key     TEXT,
  path         TEXT NOT NULL,
  side         TEXT NOT NULL,
  start_line   INTEGER NOT NULL,
  end_line     INTEGER NOT NULL,
  code         TEXT,
  body         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open',
  posted_url   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_scope ON note (scope_key, status);

CREATE TABLE IF NOT EXISTS note_reply (
  id         TEXT PRIMARY KEY,
  note_id    TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
  author     TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS note_reply_note ON note_reply (note_id);

CREATE TABLE IF NOT EXISTS pr_review (
  id           TEXT PRIMARY KEY,
  scope_key    TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  deep         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL,
  body         TEXT,
  model        TEXT,
  reasoning_effort TEXT,
  thread_id    TEXT,
  activity     TEXT,
  error        TEXT,
  started_at   TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS pr_review_scope ON pr_review (scope_key, started_at DESC);

CREATE TABLE IF NOT EXISTS pr_review_message (
  id         TEXT PRIMARY KEY,
  review_id  TEXT NOT NULL REFERENCES pr_review(id) ON DELETE CASCADE,
  node_key   TEXT NOT NULL,
  node_id    TEXT,
  role       TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pr_review_message_review ON pr_review_message (review_id, created_at);
`;

export function openDb(repoRoot) {
	const file = databaseFile(repoRoot);
	mkdirSync(dirname(file), { recursive: true });
	const db = new DatabaseSync(file);
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA foreign_keys = ON');
	db.exec(SCHEMA);
	const reviewColumns = new Set(db.prepare('PRAGMA table_info(pr_review)').all().map((column) => column.name));
	if (!reviewColumns.has('reasoning_effort')) db.exec('ALTER TABLE pr_review ADD COLUMN reasoning_effort TEXT');
	return db;
}

const now = () => new Date().toISOString();

export function createPrReview(db, review) {
	const timestamp = now();
	db.prepare(
		`INSERT INTO pr_review
		 (id, scope_key, content_hash, deep, status, model, reasoning_effort, activity, started_at)
		 VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?)`,
	).run(
		review.id, review.scopeKey, review.contentHash, review.deep ? 1 : 0,
		review.model ?? null, review.reasoningEffort ?? null,
		review.activity ?? 'Starting Codex…', timestamp,
	);
	return getPrReview(db, review.id);
}

export function getPrReview(db, id) {
	return db.prepare('SELECT * FROM pr_review WHERE id = ?').get(id) ?? null;
}

export function latestPrReview(db, scopeKey) {
	return db.prepare('SELECT * FROM pr_review WHERE scope_key = ? ORDER BY started_at DESC LIMIT 1').get(scopeKey) ?? null;
}

export function updatePrReview(db, id, fields) {
	const allowed = ['status', 'body', 'model', 'reasoning_effort', 'thread_id', 'activity', 'error', 'completed_at'];
	const sets = [];
	const values = [];
	for (const key of allowed) {
		if (fields[key] !== undefined) { sets.push(`${key} = ?`); values.push(fields[key]); }
	}
	if (!sets.length) return getPrReview(db, id);
	values.push(id);
	db.prepare(`UPDATE pr_review SET ${sets.join(', ')} WHERE id = ?`).run(...values);
	return getPrReview(db, id);
}

export function completePrReview(db, id, result) {
	return updatePrReview(db, id, {
		status: 'complete', body: result.body, model: result.model,
		reasoning_effort: result.reasoningEffort ?? null,
		thread_id: result.threadId ?? null, activity: 'Review complete', error: null,
		completed_at: now(),
	});
}

export function createPrReviewMessage(db, { reviewId, nodeKey, nodeId, role, body }) {
	const message = {
		id: randomUUID(), review_id: reviewId, node_key: nodeKey, node_id: nodeId ?? null,
		role, body, created_at: now(),
	};
	db.prepare(
		`INSERT INTO pr_review_message (id, review_id, node_key, node_id, role, body, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(message.id, message.review_id, message.node_key, message.node_id, message.role, message.body, message.created_at);
	return message;
}

export function listPrReviewMessages(db, reviewId) {
	if (!reviewId) return [];
	return db.prepare('SELECT * FROM pr_review_message WHERE review_id = ? ORDER BY created_at, rowid').all(reviewId);
}

export function failPrReview(db, id, error, threadId = null) {
	return updatePrReview(db, id, {
		status: 'failed', error: String(error), thread_id: threadId,
		activity: 'Review stopped', completed_at: now(),
	});
}

export function getExplanation(db, nodeKey, contentHash, mode) {
	return db
		.prepare('SELECT * FROM explanation WHERE node_key = ? AND content_hash = ? AND mode = ?')
		.get(nodeKey, contentHash, mode) ?? null;
}

export function putExplanation(db, { nodeKey, contentHash, mode, body, model, costUsd, durationMs }) {
	db.prepare(
		`INSERT INTO explanation (node_key, content_hash, mode, body, model, cost_usd, duration_ms, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT (node_key, content_hash, mode) DO UPDATE SET
		   body = excluded.body, model = excluded.model, cost_usd = excluded.cost_usd,
		   duration_ms = excluded.duration_ms, created_at = excluded.created_at`,
	).run(nodeKey, contentHash, mode, body, model ?? null, costUsd ?? null, durationMs ?? null, now());
}

/** Every explanation already cached for this run, so the UI can show them at once. */
export function explanationsFor(db, pairs) {
	if (!pairs.length) return {};
	const statement = db.prepare('SELECT node_key, content_hash, mode, body FROM explanation WHERE node_key = ?');
	const result = {};
	for (const { nodeKey, contentHash } of pairs) {
		for (const row of statement.all(nodeKey)) {
			if (row.content_hash !== contentHash) continue;
			result[nodeKey] = result[nodeKey] ?? {};
			result[nodeKey][row.mode] = row.body;
		}
	}
	return result;
}

export function createNote(db, note) {
	const id = randomUUID();
	const timestamp = now();
	db.prepare(
		`INSERT INTO note (id, scope_key, node_key, path, side, start_line, end_line, code, body, status, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
	).run(
		id, note.scopeKey, note.nodeKey ?? null, note.path, note.side,
		note.startLine, note.endLine, note.code ?? null, note.body, timestamp, timestamp,
	);
	return getNote(db, id);
}

export function getNote(db, id) {
	const row = db.prepare('SELECT * FROM note WHERE id = ?').get(id);
	if (!row) return null;
	return { ...row, replies: db.prepare('SELECT * FROM note_reply WHERE note_id = ? ORDER BY created_at').all(id) };
}

/** Accepts a full id or any unambiguous prefix of at least 6 characters. */
export function resolveNoteId(db, idOrPrefix) {
	if (idOrPrefix.length >= 36) return idOrPrefix;
	if (idOrPrefix.length < 6) throw new Error('Note id prefixes must be at least 6 characters.');
	const matches = db.prepare('SELECT id FROM note WHERE id LIKE ?').all(`${idOrPrefix}%`);
	if (matches.length === 0) throw new Error(`No note matches "${idOrPrefix}".`);
	if (matches.length > 1) throw new Error(`"${idOrPrefix}" matches ${matches.length} notes. Use a longer prefix.`);
	return matches[0].id;
}

export function listNotes(db, { scopeKey, status } = {}) {
	const clauses = [];
	const values = [];
	if (scopeKey) { clauses.push('scope_key = ?'); values.push(scopeKey); }
	if (status && status !== 'all') { clauses.push('status = ?'); values.push(status); }
	const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
	const rows = db.prepare(`SELECT * FROM note ${where} ORDER BY path, start_line`).all(...values);
	const replies = db.prepare('SELECT * FROM note_reply WHERE note_id = ? ORDER BY created_at');
	return rows.map((row) => ({ ...row, replies: replies.all(row.id) }));
}

export function updateNote(db, id, fields) {
	const allowed = ['body', 'status', 'posted_url'];
	const sets = [];
	const values = [];
	for (const key of allowed) {
		if (fields[key] !== undefined) { sets.push(`${key} = ?`); values.push(fields[key]); }
	}
	if (!sets.length) return getNote(db, id);
	sets.push('updated_at = ?');
	values.push(now(), id);
	db.prepare(`UPDATE note SET ${sets.join(', ')} WHERE id = ?`).run(...values);
	return getNote(db, id);
}

export function deleteNote(db, id) {
	db.prepare('DELETE FROM note WHERE id = ?').run(id);
}

export function addReply(db, noteId, author, body) {
	const id = randomUUID();
	db.prepare('INSERT INTO note_reply (id, note_id, author, body, created_at) VALUES (?, ?, ?, ?, ?)')
		.run(id, noteId, author, body, now());
	db.prepare('UPDATE note SET updated_at = ? WHERE id = ?').run(now(), noteId);
	return getNote(db, noteId);
}
