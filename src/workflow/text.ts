import { visibleWidth } from "@earendil-works/pi-tui";
import { stripAnsi } from "../runner/index.ts";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function normalizeRenderableText(value: string) {
	let rendered = "";
	for (const char of stripAnsi(value)) {
		if (char === "\t") {
			rendered += "  ";
			continue;
		}
		const code = char.codePointAt(0) ?? 0;
		if (
			(code >= 0 && code <= 8) ||
			code === 11 ||
			code === 12 ||
			(code >= 14 && code <= 31) ||
			code === 127 ||
			(code >= 128 && code <= 159)
		)
			continue;
		rendered += char;
	}
	return rendered;
}

export function truncatePlainToWidth(value: string, width: number, ellipsis = "…") {
	const safeWidth = Math.max(1, width);
	const plain = normalizeRenderableText(value);
	if (visibleWidth(plain) <= safeWidth) return plain;
	const target = Math.max(0, safeWidth - visibleWidth(ellipsis));
	let rendered = "";
	let currentWidth = 0;
	for (const segment of segmenter.segment(plain)) {
		const nextWidth = visibleWidth(segment.segment);
		if (currentWidth + nextWidth > target) break;
		rendered += segment.segment;
		currentWidth += nextWidth;
	}
	return `${rendered}${ellipsis}`;
}
