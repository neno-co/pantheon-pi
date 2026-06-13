export const DETERMINISTIC_EMBEDDING_DIMENSIONS = 64;

function tokensFor(text: string) {
	return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function hashToken(token: string) {
	let hash = 2166136261;
	for (let index = 0; index < token.length; index++) {
		hash ^= token.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

export function embedDeterministic(text: string, dimensions = DETERMINISTIC_EMBEDDING_DIMENSIONS) {
	const vector = Array.from({ length: dimensions }, () => 0);
	for (const token of tokensFor(text)) {
		const hash = hashToken(token);
		const index = hash % dimensions;
		vector[index] += 1;
	}
	const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
	return norm === 0 ? vector : vector.map((value) => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]) {
	const length = Math.min(a.length, b.length);
	let score = 0;
	for (let index = 0; index < length; index++) score += a[index] * b[index];
	return score;
}
