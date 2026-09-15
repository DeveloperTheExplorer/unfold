/**
 * Architectural classification. A change is read in the order it would have been
 * built — contracts, then what can call them, then what they do, then what they
 * persist — so the path never depends on where a file happens to sit.
 *
 * Every rule here reads a decorator, a path convention or a declaration kind.
 * Nothing is inferred by a model.
 */

export const LAYERS = [
	{ id: 'contracts', title: 'Contracts', blurb: 'the shapes everything else agrees on' },
	{ id: 'entry', title: 'Entry points', blurb: 'what can be triggered, and what refuses it' },
	{ id: 'services', title: 'Services', blurb: 'what the change achieves' },
	{ id: 'persistence', title: 'Persistence', blurb: 'what it reads and writes' },
	{ id: 'external', title: 'External calls', blurb: 'what it talks to outside the process' },
	{ id: 'wiring', title: 'Wiring', blurb: 'registration, configuration and startup' },
	{ id: 'surface', title: 'Surface', blurb: 'what the user touches' },
	{ id: 'tests', title: 'Tests', blurb: 'what is now pinned down' },
	{ id: 'imports', title: 'Imports and top level', blurb: 'wiring at the top of files, rarely the story' },
	{ id: 'other', title: 'Everything else', blurb: 'nothing here matched a known layer' },
];

export const LAYER_IDS = LAYERS.map((layer) => layer.id);
export const layerMeta = (id) => LAYERS.find((layer) => layer.id === id) ?? LAYERS.at(-1);

const TEST_PATH = /(\.|\/)(test|spec)\.[cm]?[jt]sx?$|(^|\/)__tests__\//;
const TYPE_KINDS = new Set(['interface', 'type', 'enum']);
const ROUTE_DECORATOR = /@(Get|Post|Put|Patch|Delete|Head|Options)\(\s*['"`]([^'"`]*)['"`]/;

/**
 * Order matters: the first rule that matches wins, and the narrower signal comes
 * first. Repositories are `@Service()` classes too, so persistence is tested
 * before services.
 */
export function classifyConcept({ path = '', symbolKind = '', body = '', fileText = '' }) {
	if (TEST_PATH.test(path)) return 'tests';
	if (TYPE_KINDS.has(symbolKind)) return 'contracts';

	if (/(^|\/)migrations\//.test(path)) return 'persistence';
	if (/@Entity\(/.test(body) || /(^|\/)entities\//.test(path)) return 'persistence';
	if (/\.repository\.ts$/.test(path) || /extends\s+\w*Repository\b/.test(body)) return 'persistence';

	if (ROUTE_DECORATOR.test(body) || /@RestController/.test(body)) return 'entry';
	if (/\.controller\.ts$/.test(path)) return 'entry';
	if (/@(OnPubSubEvent|SystemTask|OnLifecycleEvent|OnShutdown)\b/.test(body)) return 'entry';
	if (/(^|\/)commands\//.test(path) || /extends\s+BaseCommand\b/.test(body)) return 'entry';

	if (/\.client\.ts$/.test(path) || /(^|\/)clients?\//.test(path)) return 'external';

	if (/\.module\.ts$/.test(path) || /@BackendModule/.test(body)) return 'wiring';
	if (/@Config\b/.test(body) || /@Env\(/.test(body) || /\.config\.ts$/.test(path)) return 'wiring';

	if (/\.dto\.ts$/.test(path) || /(^|\/)api-types\//.test(path) || /\.types\.ts$/.test(path)) return 'contracts';
	if (/(^|\/)(constants|schema|schemas)\.ts$/.test(path)) return 'contracts';

	if (/\.vue$/.test(path) || /(^|\/)stores\//.test(path) || /composables\//.test(path)) return 'surface';
	if (/defineStore\(/.test(body) || /(^|\/)views\//.test(path) || /components\//.test(path)) return 'surface';

	if (/\.service\.ts$/.test(path) || /@Service\(/.test(body)) return 'services';
	return 'other';
}

const MAX_HEAD_LINES = 48;

/**
 * Wide enough to hold the decorators and the whole handler signature. Stopping
 * at the first `{` looks tidier but lands inside a route's own options object,
 * and a window that ends early drops a guard from facts shown as established.
 * The patterns below only match decorator and parameter syntax, so scanning a
 * little of the body costs nothing.
 */
function decoratorHead(body) {
	return body.split('\n').slice(0, MAX_HEAD_LINES).join('\n');
}

function flagsIn(head) {
	return ['skipAuth', 'allowUnauthenticated', 'apiKeyAuth', 'allowSkipMFA', 'allowBots', 'allowSkipPreviewAuth']
		.filter((flag) => new RegExp(`${flag}\\s*:\\s*true`).test(head));
}

function authFrom(flags) {
	if (flags.includes('allowUnauthenticated') || flags.includes('skipAuth')) return 'none — public';
	if (flags.includes('apiKeyAuth')) return 'API key';
	return 'session cookie';
}

/**
 * What an endpoint accepts and refuses, read out of its decorator arguments.
 * These are facts, so the model is told not to restate them.
 */
export function endpointFacts({ symbolKind = '', body = '', fileText = '' }) {
	if (!['method', 'function', 'accessor'].includes(symbolKind)) return null;
	const route = body.match(ROUTE_DECORATOR);
	if (!route) return null;

	const head = decoratorHead(body);
	const base = fileText.match(/@RestController\(\s*['"`]([^'"`]*)['"`]/)?.[1] ?? '';
	// A decorator argument is a string literal or a constant reference, e.g.
	// @Licensed(LICENSE_FEATURES.NODE_TYPE_POLICIES).
	const argument = String.raw`(?:['"\`]([^'"\`]+)['"\`]|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*))`;
	const scoped = head.match(new RegExp(String.raw`@(GlobalScope|ProjectScope)\(\s*${argument}`));
	const licensed = head.match(new RegExp(String.raw`@Licensed\(\s*${argument}`));
	const flags = flagsIn(head);
	const limitKind = head.match(/\b(ipRateLimit|keyedRateLimit)\b/)?.[1] ?? null;
	const limitDetail = limitKind
		? head.match(new RegExp(`${limitKind}\\s*:\\s*\\{([^}]*)\\}`))?.[1]?.replace(/\s+/g, ' ').trim()
		: null;
	// The body DTO is the interesting contract; the request type is context.
	const validates = [
		...[...head.matchAll(/@Body(?:\(\))?\s+\w+\s*:\s*([A-Za-z0-9_]+)/g)].map((match) => match[1]),
		...[...head.matchAll(/@(?:Query|Param)(?:\(\))?\s+\w+\s*:\s*([A-Za-z0-9_]+)/g)].map((match) => match[1]),
		...[...head.matchAll(/\breq\s*:\s*([A-Za-z0-9_.]+)/g)].map((match) => match[1]),
	].filter((name, index, all) => all.indexOf(name) === index);

	return {
		verb: route[1].toUpperCase(),
		route: `${base}${route[2]}` || '/',
		auth: authFrom(flags),
		flags,
		scope: scoped ? `${scoped[1]}(${scoped[2] ? `'${scoped[2]}'` : scoped[3]})` : null,
		licence: licensed ? (licensed[2] ?? licensed[3]) : null,
		limit: limitKind ? (limitDetail ? `${limitKind} { ${limitDetail} }` : limitKind) : null,
		validates,
		takesParams: /@Param\(/.test(head),
		takesQuery: /@Query\(/.test(head),
		cors: /\bcors\s*:/.test(head),
	};
}

/** A one-line rendering used in the tree, the overview table and prompts. */
export function factsLine(facts) {
	if (!facts) return null;
	const parts = [`auth ${facts.auth}`];
	parts.push(`scope ${facts.scope ?? 'none'}`);
	if (facts.licence) parts.push(`licence ${facts.licence}`);
	if (facts.limit) parts.push(`limit ${facts.limit}`);
	if (facts.validates?.length) parts.push(`validates ${facts.validates.join(', ')}`);
	return parts.join(' · ');
}
