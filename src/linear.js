const LINEAR_URL = /https:\/\/linear\.app\/(?:(?!issue\/)([^\s/)]+)\/)?issue\/([A-Z][A-Z0-9]+-\d+)(?:\/([A-Za-z0-9_-]+))?/gi;

function titleFromSlug(slug) {
	if (!slug) return null;
	return decodeURIComponent(slug).replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Linear issue references embedded in the PR description, in document order. */
export function linearReferences(text = '') {
	const found = [];
	const seen = new Set();
	for (const match of String(text).matchAll(LINEAR_URL)) {
		const identifier = match[2].toUpperCase();
		if (seen.has(identifier)) continue;
		seen.add(identifier);
		found.push({
			identifier,
			url: match[0],
			workspace: match[1],
			title: titleFromSlug(match[3]),
			resolved: false,
		});
		if (found.length >= 6) break;
	}
	return found;
}

function authorization(env) {
	if (env.LINEAR_ACCESS_TOKEN) return `Bearer ${env.LINEAR_ACCESS_TOKEN}`;
	return env.LINEAR_API_KEY ?? null;
}

async function fetchIssue(reference, auth) {
	const response = await fetch('https://api.linear.app/graphql', {
		method: 'POST',
		headers: { 'content-type': 'application/json', authorization: auth },
		body: JSON.stringify({
			query: `query IntentIssue($id: String!) {
				issue(id: $id) { identifier title description url state { name } project { name } }
			}`,
			variables: { id: reference.identifier },
		}),
		signal: AbortSignal.timeout(6000),
	});
	if (!response.ok) throw new Error(`Linear returned HTTP ${response.status}`);
	const payload = await response.json();
	if (payload.errors?.length || !payload.data?.issue) throw new Error(payload.errors?.[0]?.message ?? 'Issue not found');
	const issue = payload.data.issue;
	return {
		...reference,
		identifier: issue.identifier ?? reference.identifier,
		title: issue.title ?? reference.title,
		description: String(issue.description ?? '').slice(0, 6000),
		url: issue.url ?? reference.url,
		state: issue.state?.name ?? null,
		project: issue.project?.name ?? null,
		resolved: true,
	};
}

/** Resolve linked issues when a server-side credential is configured. */
export async function linkedLinearIssues(text, env = process.env) {
	const references = linearReferences(text);
	const auth = authorization(env);
	if (!references.length || !auth) return references;
	return Promise.all(references.map(async (reference) => {
		try {
			return await fetchIssue(reference, auth);
		} catch (error) {
			return { ...reference, error: String(error.message).slice(0, 160) };
		}
	}));
}
