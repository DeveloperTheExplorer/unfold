import { factsLine } from './layers.js';

/** Plain-text tree renderer, used by `unfold tree` and for prompt context. */
const GLYPH = { root: '', group: '', file: '', symbol: '', hunk: '' };

export function renderTree(root, { maxDepth = 99, showHunks = true } = {}) {
	const lines = [];
	const stats = (node) => (node.added || node.removed ? `  [+${node.added} −${node.removed}]` : '');
	const walk = (node, prefix, isLast, depth) => {
		if (depth > maxDepth) return;
		if (!showHunks && node.kind === 'hunk') return;
		if (depth === 0) {
			lines.push(`${node.label}${stats(node)}`);
		} else if (node.kind === 'layer') {
			lines.push('');
			lines.push(`${node.payload.step}. ${node.label.toUpperCase()} — ${node.payload.blurb}${stats(node)}`);
		} else {
			const step = node.payload?.step ? `${String(node.payload.step).padStart(3)}. ` : '     ';
			const kindTag = node.kind === 'symbol' && !node.payload.facts ? `${node.payload.symbolKind} ` : '';
			lines.push(`${prefix}${step}${kindTag}${node.label}${stats(node)}`);
			if (node.payload?.facts) {
				lines.push(`${prefix}      ${factsLine(node.payload.facts)}`);
			}
			if (node.payload?.path && node.payload.isConcept) {
				lines.push(`${prefix}      ${node.payload.path}`);
			}
		}
		const children = showHunks ? node.children : node.children.filter((c) => c.kind !== 'hunk');
		children.forEach((child, index) => {
			const nextPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : '│   ');
			walk(child, nextPrefix, index === children.length - 1, depth + 1);
		});
	};
	walk(root, '', true, 0);
	return lines.join('\n');
}
