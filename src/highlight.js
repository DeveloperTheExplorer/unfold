import { createHash } from 'node:crypto';

/**
 * Highlighting happens here, on the server, once per distinct block, and the
 * browser only ever receives finished HTML for the lines it is showing. That is
 * the whole memory strategy: no grammars, no themes and no token arrays in the tab.
 */

const LANGUAGES = {
	ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
	vue: 'vue', json: 'json', jsonc: 'json', md: 'markdown', mdx: 'markdown',
	yaml: 'yaml', yml: 'yaml', css: 'css', scss: 'scss', less: 'css',
	html: 'html', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
	py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
	toml: 'toml', graphql: 'graphql', prisma: 'prisma', xml: 'xml',
};

const THEME = 'github-dark-default';
const MAX_CACHE_ENTRIES = 400;

let highlighterPromise = null;
const cache = new Map();

export function escapeHtml(text) {
	return text
		.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function languageFor(extension) {
	return LANGUAGES[String(extension ?? '').toLowerCase()] ?? null;
}

async function highlighter() {
	if (!highlighterPromise) {
		highlighterPromise = (async () => {
			const { createHighlighter } = await import('shiki');
			return createHighlighter({
				themes: [THEME],
				langs: [...new Set(Object.values(LANGUAGES))],
			});
		})().catch(() => null);
	}
	return highlighterPromise;
}

function remember(key, value) {
	if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
	cache.set(key, value);
	return value;
}

/**
 * One HTML string per input line. Falls back to escaped text when shiki is
 * unavailable or the language is unknown, so the tool still works without it.
 */
export async function highlightLines(lines, extension) {
	const language = languageFor(extension);
	const key = createHash('sha256').update(`${language}\n${lines.join('\n')}`).digest('hex');
	if (cache.has(key)) return cache.get(key);
	if (!language) return remember(key, lines.map(escapeHtml));

	const shiki = await highlighter();
	if (!shiki) return remember(key, lines.map(escapeHtml));

	try {
		const { tokens } = shiki.codeToTokens(lines.join('\n'), { lang: language, theme: THEME });
		const html = tokens.map((tokenLine) =>
			tokenLine
				.map((token) => `<span style="color:${token.color ?? 'inherit'}">${escapeHtml(token.content)}</span>`)
				.join(''),
		);
		// Guard against a token/line count mismatch on odd inputs.
		while (html.length < lines.length) html.push(escapeHtml(lines[html.length]));
		return remember(key, html.slice(0, lines.length));
	} catch {
		return remember(key, lines.map(escapeHtml));
	}
}

export function highlightStats() {
	return { entries: cache.size, theme: THEME };
}
