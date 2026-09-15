/**
 * Minimal unified-diff parser. Keeps both line numbers for every line, which is
 * what anchors notes and what the symbol mapper needs to place hunks in the
 * parsed file.
 */

const MAX_LINES_PER_FILE = 20000;

function stripPrefix(path) {
	if (path === '/dev/null') return null;
	if (path.startsWith('a/') || path.startsWith('b/')) return path.slice(2);
	return path;
}

function unquote(path) {
	if (!path.startsWith('"')) return path;
	try {
		return JSON.parse(path);
	} catch {
		return path.slice(1, -1);
	}
}

function pathsFromHeader(line) {
	// `diff --git a/x b/y`, with either side possibly quoted.
	const rest = line.slice('diff --git '.length);
	if (rest.startsWith('"')) {
		const match = rest.match(/^("(?:[^"\\]|\\.)*") ("(?:[^"\\]|\\.)*")$/);
		if (match) return [stripPrefix(unquote(match[1])), stripPrefix(unquote(match[2]))];
	}
	const half = Math.floor(rest.length / 2);
	// Both sides are the same path in the common case; split on the midpoint space.
	const spaceAt = rest.lastIndexOf(' ', half + 1) === -1 ? rest.indexOf(' ') : rest.lastIndexOf(' ', half + 1);
	if (spaceAt > 0) return [stripPrefix(rest.slice(0, spaceAt)), stripPrefix(rest.slice(spaceAt + 1))];
	return [null, null];
}

export function parsePatch(patch) {
	const lines = patch.split('\n');
	// `split` leaves an empty tail for the final newline; treating it as a blank
	// context line invents a line at the end of the last file.
	if (lines.length && lines[lines.length - 1] === '') lines.pop();
	const files = [];
	let file = null;
	let hunk = null;
	let oldLine = 0;
	let newLine = 0;

	const pushFile = () => {
		if (file) {
			file.path = file.newPath ?? file.oldPath;
			files.push(file);
		}
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];

		if (line.startsWith('diff --git ')) {
			pushFile();
			const [oldPath, newPath] = pathsFromHeader(line);
			file = {
				oldPath, newPath, path: newPath ?? oldPath,
				status: 'modified', binary: false, truncated: false,
				added: 0, removed: 0, lineCount: 0, hunks: [],
			};
			hunk = null;
			continue;
		}
		if (!file) continue;

		if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
		if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
		if (line.startsWith('rename from ')) { file.oldPath = unquote(line.slice(12)); file.status = 'renamed'; continue; }
		if (line.startsWith('rename to ')) { file.newPath = unquote(line.slice(10)); file.status = 'renamed'; continue; }
		if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) { file.binary = true; continue; }
		if (line.startsWith('--- ')) {
			const p = stripPrefix(unquote(line.slice(4).trim()));
			if (p) file.oldPath = p; else file.status = 'added';
			continue;
		}
		if (line.startsWith('+++ ')) {
			const p = stripPrefix(unquote(line.slice(4).trim()));
			if (p) file.newPath = p; else file.status = 'deleted';
			continue;
		}

		const hunkHeader = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
		if (hunkHeader) {
			hunk = {
				index: file.hunks.length + 1,
				oldStart: Number(hunkHeader[1]),
				oldLines: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]),
				newStart: Number(hunkHeader[3]),
				newLines: hunkHeader[4] === undefined ? 1 : Number(hunkHeader[4]),
				header: hunkHeader[5] ?? '',
				lines: [],
				added: 0,
				removed: 0,
			};
			file.hunks.push(hunk);
			oldLine = hunk.oldStart;
			newLine = hunk.newStart;
			continue;
		}
		if (!hunk) continue;

		const kind = line[0];
		if (kind === '\\') continue; // "\ No newline at end of file"
		if (file.lineCount >= MAX_LINES_PER_FILE) { file.truncated = true; continue; }

		if (kind === '+') {
			hunk.lines.push({ t: '+', o: null, n: newLine++, s: line.slice(1) });
			hunk.added++; file.added++; file.lineCount++;
		} else if (kind === '-') {
			hunk.lines.push({ t: '-', o: oldLine++, n: null, s: line.slice(1) });
			hunk.removed++; file.removed++; file.lineCount++;
		} else if (kind === ' ' || line === '') {
			hunk.lines.push({ t: ' ', o: oldLine++, n: newLine++, s: line.slice(1) });
			file.lineCount++;
		}
	}
	pushFile();
	return files.filter((f) => f.path);
}

/** New-side line span a hunk touches, used to locate it inside the parsed file. */
export function hunkNewSpan(hunk) {
	const touched = hunk.lines.filter((l) => l.t === '+').map((l) => l.n);
	if (touched.length) return [Math.min(...touched), Math.max(...touched)];
	// Pure deletion: anchor on the surrounding context so it still lands in a symbol.
	const context = hunk.lines.filter((l) => l.n !== null).map((l) => l.n);
	if (context.length) return [Math.min(...context), Math.max(...context)];
	return [hunk.newStart, hunk.newStart];
}

export function hunkOldSpan(hunk) {
	const touched = hunk.lines.filter((l) => l.t === '-').map((l) => l.o);
	if (touched.length) return [Math.min(...touched), Math.max(...touched)];
	const context = hunk.lines.filter((l) => l.o !== null).map((l) => l.o);
	if (context.length) return [Math.min(...context), Math.max(...context)];
	return [hunk.oldStart, hunk.oldStart];
}

/** Reconstruct the patch text for one hunk, for prompts and note bodies. */
export function hunkText(file, hunk, { withLineNumbers = true } = {}) {
	const head = `--- a/${file.oldPath ?? file.path}\n+++ b/${file.newPath ?? file.path}\n@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@ ${hunk.header}`;
	const body = hunk.lines
		.map((l) => {
			if (!withLineNumbers) return `${l.t}${l.s}`;
			const o = l.o === null ? '    ' : String(l.o).padStart(4);
			const n = l.n === null ? '    ' : String(l.n).padStart(4);
			return `${o} ${n} |${l.t}${l.s}`;
		})
		.join('\n');
	return `${head}\n${body}`;
}
