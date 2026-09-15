import ts from 'typescript';
import { extname, basename } from 'node:path';

/**
 * Turns a file into a nested outline of named regions with 1-based line ranges.
 * This is the deterministic spine of the tree: no model decides what a node is.
 */

const SCRIPT_KINDS = {
	'.ts': ts.ScriptKind.TS,
	'.mts': ts.ScriptKind.TS,
	'.cts': ts.ScriptKind.TS,
	'.tsx': ts.ScriptKind.TSX,
	'.js': ts.ScriptKind.JS,
	'.mjs': ts.ScriptKind.JS,
	'.cjs': ts.ScriptKind.JS,
	'.jsx': ts.ScriptKind.JSX,
};

const MARKDOWN = new Set(['.md', '.mdx', '.markdown']);

/** Statement-level calls that structure a file as much as a declaration does. */
const BLOCK_CALLS = new Set([
	'describe', 'describe.only', 'describe.skip', 'describe.each',
	'it', 'it.only', 'it.skip', 'it.each',
	'test', 'test.only', 'test.skip', 'test.each',
	'suite', 'context', 'beforeAll', 'beforeEach', 'afterAll', 'afterEach',
]);

/** Only these recurse: a leaf assertion's local variables are not structure. */
const NESTING_BLOCK_CALLS = new Set(['describe', 'suite', 'context']);

/** Inside a test block, keep other blocks and helpers but drop plain data locals. */
const STRUCTURAL_KINDS = new Set(['function', 'class', 'describe', 'it', 'test', 'suite', 'context']);

function isStructural(symbol) {
	return STRUCTURAL_KINDS.has(symbol.kind);
}

export function supportsOutline(path) {
	const ext = extname(path).toLowerCase();
	return ext in SCRIPT_KINDS || ext === '.vue' || MARKDOWN.has(ext);
}

function lineOf(sourceFile, position) {
	return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function nodeStartLine(node, sourceFile, text) {
	return lineOf(sourceFile, ts.skipTrivia(text, node.pos));
}

function calleeName(expression) {
	if (ts.isIdentifier(expression)) return expression.text;
	if (ts.isPropertyAccessExpression(expression)) {
		const left = calleeName(expression.expression);
		return left ? `${left}.${expression.name.text}` : null;
	}
	return null;
}

function initializerKind(initializer) {
	if (!initializer) return 'const';
	if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) return 'function';
	if (ts.isClassExpression(initializer)) return 'class';
	if (ts.isObjectLiteralExpression(initializer)) return 'object';
	if (ts.isCallExpression(initializer)) return 'const';
	return 'const';
}

function isExported(node) {
	return Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
}

function collectStatements(statements, sourceFile, text, out) {
	for (const node of statements) {
		const start = nodeStartLine(node, sourceFile, text);
		const end = lineOf(sourceFile, node.end);
		const add = (name, kind, children = []) =>
			out.push({ name, kind, start, end, exported: isExported(node), children });

		if (ts.isFunctionDeclaration(node)) {
			add(node.name?.text ?? '(anonymous)', 'function');
		} else if (ts.isClassDeclaration(node)) {
			add(node.name?.text ?? '(anonymous class)', 'class', collectMembers(node.members, sourceFile, text));
		} else if (ts.isInterfaceDeclaration(node)) {
			add(node.name.text, 'interface');
		} else if (ts.isTypeAliasDeclaration(node)) {
			add(node.name.text, 'type');
		} else if (ts.isEnumDeclaration(node)) {
			add(node.name.text, 'enum');
		} else if (ts.isModuleDeclaration(node)) {
			const children = node.body && ts.isModuleBlock(node.body)
				? collectStatements(node.body.statements, sourceFile, text, [])
				: [];
			add(node.name.getText?.(sourceFile) ?? String(node.name.text ?? 'namespace'), 'namespace', children);
		} else if (ts.isVariableStatement(node)) {
			for (const declaration of node.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) continue;
				const kind = initializerKind(declaration.initializer);
				const children = kind === 'class' && declaration.initializer?.members
					? collectMembers(declaration.initializer.members, sourceFile, text)
					: [];
				out.push({
					name: declaration.name.text, kind, start,
					end: lineOf(sourceFile, declaration.end), exported: isExported(node), children,
				});
			}
		} else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
			const callee = calleeName(node.expression.expression);
			if (!callee || !BLOCK_CALLS.has(callee)) continue;
			const base = callee.split('.')[0];
			const [first, ...rest] = node.expression.arguments;
			const label = first && ts.isStringLiteralLike(first) ? first.text : callee;
			const body = NESTING_BLOCK_CALLS.has(base)
				? rest.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument))
				: null;
			const children = body?.body && ts.isBlock(body.body)
				? collectStatements(body.body.statements, sourceFile, text, []).filter(isStructural)
				: [];
			out.push({ name: label, kind: base, start, end, exported: false, children });
		}
	}
	return out;
}

function collectMembers(members, sourceFile, text) {
	const out = [];
	for (const member of members) {
		const start = nodeStartLine(member, sourceFile, text);
		const end = lineOf(sourceFile, member.end);
		const name = member.name && !ts.isComputedPropertyName(member.name)
			? String(member.name.text ?? member.name.getText?.(sourceFile) ?? '')
			: null;
		if (ts.isConstructorDeclaration(member)) {
			out.push({ name: 'constructor', kind: 'method', start, end, exported: false, children: [] });
		} else if (ts.isMethodDeclaration(member)) {
			out.push({ name: name ?? '(method)', kind: 'method', start, end, exported: false, children: [] });
		} else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
			const prefix = ts.isGetAccessor(member) ? 'get ' : 'set ';
			out.push({ name: prefix + (name ?? ''), kind: 'accessor', start, end, exported: false, children: [] });
		} else if (ts.isPropertyDeclaration(member)) {
			const kind = initializerKind(member.initializer) === 'function' ? 'method' : 'property';
			// Only surface data properties that span lines; one-liners are noise.
			if (kind === 'method' || end > start) {
				out.push({ name: name ?? '(property)', kind, start, end, exported: false, children: [] });
			}
		}
	}
	return out;
}

function collectImports(sourceFile) {
	const imports = [];
	for (const statement of sourceFile.statements) {
		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
		const module = statement.moduleSpecifier.text;
		const typeOnly = Boolean(statement.importClause?.isTypeOnly);
		const names = [];
		const clause = statement.importClause;
		if (clause?.name) names.push({ local: clause.name.text, imported: 'default', typeOnly });
		if (clause?.namedBindings) {
			if (ts.isNamespaceImport(clause.namedBindings)) {
				names.push({ local: clause.namedBindings.name.text, imported: '*', typeOnly });
			} else {
				for (const element of clause.namedBindings.elements) {
					names.push({
						local: element.name.text,
						imported: element.propertyName?.text ?? element.name.text,
						typeOnly: typeOnly || Boolean(element.isTypeOnly),
					});
				}
			}
		}
		imports.push({ module, names });
	}
	return imports;
}

function shiftLines(symbols, offset) {
	for (const symbol of symbols) {
		symbol.start += offset;
		symbol.end += offset;
		shiftLines(symbol.children, offset);
	}
	return symbols;
}

function vueOutline(text) {
	const symbols = [];
	let imports = [];
	const blockPattern = /<(script|template|style)([^>]*)>([\s\S]*?)<\/\1>/g;
	for (const match of text.matchAll(blockPattern)) {
		const [full, tag, attributes, body] = match;
		const offset = text.slice(0, match.index).split('\n').length - 1;
		const start = offset + 1;
		const end = offset + full.split('\n').length;
		const label = `<${tag}${/setup/.test(attributes) ? ' setup' : ''}>`;
		if (tag === 'script') {
			const kind = /lang=["']tsx?["']/.test(attributes) ? '.ts' : '.js';
			const inner = analyseScript(`vue${kind}`, body, SCRIPT_KINDS[kind]);
			const bodyOffset = offset + full.slice(0, full.indexOf(body)).split('\n').length - 1;
			imports = inner.imports;
			symbols.push({
				name: label, kind: 'block', start, end, exported: false,
				children: shiftLines(inner.symbols, bodyOffset),
			});
		} else {
			symbols.push({ name: label, kind: 'block', start, end, exported: false, children: [] });
		}
	}
	return { symbols, imports };
}

function markdownOutline(text) {
	const lines = text.split('\n');
	const roots = [];
	const stack = [];
	let inFence = false;
	lines.forEach((line, index) => {
		if (/^\s*```/.test(line)) inFence = !inFence;
		if (inFence) return;
		const heading = line.match(/^(#{1,6})\s+(.*)$/);
		if (!heading) return;
		const level = heading[1].length;
		const symbol = { name: heading[2].trim(), kind: `h${level}`, start: index + 1, end: lines.length, exported: false, children: [], level };
		while (stack.length && stack[stack.length - 1].level >= level) {
			stack.pop().end = index;
		}
		(stack.length ? stack[stack.length - 1].children : roots).push(symbol);
		stack.push(symbol);
	});
	while (stack.length) stack.pop().end = lines.length;
	return { symbols: roots, imports: [] };
}

function analyseScript(fileName, text, scriptKind) {
	const sourceFile = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false, scriptKind);
	return {
		symbols: collectStatements(sourceFile.statements, sourceFile, text, []),
		imports: collectImports(sourceFile),
	};
}

/** `{ symbols, imports }`, or null when the file has no outline support. */
export function outline(path, text) {
	if (text == null) return null;
	const ext = extname(path).toLowerCase();
	try {
		if (ext === '.vue') return vueOutline(text);
		if (MARKDOWN.has(ext)) return markdownOutline(text);
		const scriptKind = SCRIPT_KINDS[ext];
		if (!scriptKind) return null;
		return analyseScript(basename(path), text, scriptKind);
	} catch {
		return null;
	}
}
