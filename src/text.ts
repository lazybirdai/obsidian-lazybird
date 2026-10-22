/**
 * Turns a Markdown note into plain text that reads well aloud, and splits it
 * into chunks small enough for one speech request each.
 *
 * Pure functions with no Obsidian imports, so they run under `node --test`.
 */

/** Removes Markdown, Obsidian syntax and HTML, keeping the words a reader sees. */
export function noteToSpeechText(markdown: string): string {
	let text = markdown.replace(/\r\n?/g, "\n");

	// Frontmatter at the very top of the note.
	text = text.replace(/^---\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/, "");

	// Comments: Obsidian %% … %% and HTML <!-- … -->.
	text = text.replace(/%%[\s\S]*?%%/g, " ");
	text = text.replace(/<!--[\s\S]*?-->/g, " ");

	// Fenced code blocks and display math.
	text = text.replace(/^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n[ \t]*\1[ \t]*(?=\n|$)|$)/gm, "\n");
	text = text.replace(/\$\$[\s\S]*?\$\$/g, " ");

	// Embeds: ![[file]] and ![alt](url) are files or other notes, not text.
	text = text.replace(/!\[\[[^\]\n]*\]\]/g, " ");
	text = text.replace(/!\[[^\]\n]*\]\([^)\n]*\)/g, " ");

	// Wikilinks keep the text a reader sees.
	text = text.replace(/\[\[([^\]\n]*)\]\]/g, (_m, inner: string) => wikilinkText(inner));

	// Markdown links keep their text; footnote markers go.
	text = text.replace(/\[\^[^\]\n]*\]:?/g, "");
	text = text.replace(/\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
	text = text.replace(/<(https?:\/\/[^>\s]+)>/g, " ");
	text = text.replace(/\bhttps?:\/\/[^\s)>\]]+/g, " ");

	// HTML tags go; their contents stay.
	text = text.replace(/<\/?[A-Za-z][^>\n]*>/g, " ");
	text = decodeEntities(text);

	const lines = text
		.split("\n")
		.map(cleanLine)
		.filter((line): line is string => line !== null);
	return collapseBlankLines(lines).trim();
}

function wikilinkText(inner: string): string {
	const pipe = inner.indexOf("|");
	if (pipe >= 0) return inner.slice(pipe + 1).trim();
	const [target = "", ...rest] = inner.split("#");
	const name = target.split("/").pop()?.replace(/\.md$/i, "").trim() ?? "";
	if (name) return name;
	// [[#Heading]] links to a heading in the same note.
	return rest.join(" ").replace(/^\^/, "").trim();
}

/** Returns the line as plain text, or null to drop it without a paragraph break. */
function cleanLine(raw: string): string | null {
	let line = raw;

	// Tables: drop separator rows, read cells as a list.
	if (line.includes("|") && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) return null;
	if (/^\s*\|.*\|\s*$/.test(line)) {
		const cells = line
			.trim()
			.replace(/^\||\|$/g, "")
			.split("|")
			.map((cell) => cell.trim())
			.filter(Boolean);
		line = cells.join(", ");
	}

	// Horizontal rules end a paragraph.
	if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) return "";

	// Blockquotes and callouts: "> [!note] Title" keeps the title, read like a heading.
	line = line.replace(/^(\s*>)+\s?/, "");
	const callout = /^\[![^\]]*\][+-]?\s*(.*)$/.exec(line);
	if (callout) line = endSentence(callout[1] ?? "");

	// Headings, list markers and task boxes.
	const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
	if (heading) line = endSentence(heading[1] ?? "");
	line = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX\-/>]\]\s+)?/, "");

	// Block ids, inline code ticks, emphasis and highlight markers.
	line = line.replace(/\s\^[A-Za-z0-9-]+\s*$/, "");
	line = line.replace(/`+([^`]*)`+/g, "$1");
	line = line.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2");
	line = line.replace(/(^|[^\w*])\*(?=\S)([^*\n]*?\S)\*(?=[^\w*]|$)/g, "$1$2");
	line = line.replace(/(^|[^\w])_(?=\S)([^_\n]*?\S)_(?=[^\w]|$)/g, "$1$2");
	line = line.replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
	line = line.replace(/==(?=\S)([^\n]*?\S)==/g, "$1");

	// Tags read as words: "#project" becomes "project".
	line = line.replace(/(^|\s)#([A-Za-z][\w/-]*)/g, "$1$2");

	return line.replace(/[ \t]+/g, " ").trim();
}

/** Adds a full stop to a heading so the voice pauses after it. */
function endSentence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed || /[.!?:;…。！？]$/.test(trimmed)) return trimmed;
	return `${trimmed}.`;
}

function collapseBlankLines(lines: string[]): string {
	const out: string[] = [];
	for (const line of lines) {
		if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
		out.push(line);
	}
	return out.join("\n");
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
		if (name[0] === "#") {
			const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
			return Number.isFinite(code) ? String.fromCodePoint(code) : match;
		}
		return ENTITIES[name.toLowerCase()] ?? match;
	});
}

export interface ChunkOptions {
	/** Largest chunk, in characters. */
	maxChars: number;
	/**
	 * Smaller limit for the first chunk, so playback starts sooner.
	 * Later chunks grow from here up to `maxChars`.
	 */
	firstChunkChars?: number;
}

/**
 * Splits text into chunks at paragraph, then sentence, then word boundaries.
 * Every chunk is at most its limit, unless a single word is longer.
 */
export function splitIntoChunks(text: string, options: ChunkOptions): string[] {
	const { maxChars } = options;
	let limit = Math.min(options.firstChunkChars ?? maxChars, maxChars);
	const pieces = text
		.split(/\n+/)
		.map((p) => p.trim())
		.filter(Boolean)
		.flatMap((paragraph, i, all) => {
			const parts = splitLong(paragraph, maxChars);
			// Mark paragraph ends so chunks join paragraphs with a line break.
			return parts.map((part, j) => ({ part, paragraphEnd: j === parts.length - 1 && i < all.length - 1 }));
		});

	const chunks: string[] = [];
	let current = "";
	let currentEndsParagraph = false;
	while (pieces.length > 0) {
		const piece = pieces.shift();
		if (!piece) break;
		if (piece.part.length > limit) {
			// Only the smaller first-chunk limit gets here: split the piece again for it.
			// A single word longer than the limit can't be split and goes as it is.
			const parts = splitLong(piece.part, limit);
			if (parts.length > 1) {
				pieces.unshift(...parts.map((part, j) => ({ part, paragraphEnd: j === parts.length - 1 && piece.paragraphEnd })));
				continue;
			}
		}
		const joiner = current ? (currentEndsParagraph ? "\n" : " ") : "";
		if (current && current.length + joiner.length + piece.part.length > limit) {
			chunks.push(current);
			limit = Math.min(limit * 2, maxChars);
			current = piece.part;
		} else {
			current += joiner + piece.part;
		}
		currentEndsParagraph = piece.paragraphEnd;
	}
	if (current) chunks.push(current);
	return chunks;
}

/** Splits one paragraph into parts no longer than `max`, at sentences, then words. */
function splitLong(paragraph: string, max: number): string[] {
	if (paragraph.length <= max) return [paragraph];
	const sentences = paragraph.match(/[^.!?…。！？]+(?:[.!?…。！？]+["'”’)\]]*|$)\s*/g) ?? [paragraph];
	const parts: string[] = [];
	let current = "";
	for (const raw of sentences) {
		const sentence = raw.trim();
		if (!sentence) continue;
		if (sentence.length > max) {
			if (current) parts.push(current);
			current = "";
			parts.push(...splitWords(sentence, max));
			continue;
		}
		if (current && current.length + 1 + sentence.length > max) {
			parts.push(current);
			current = sentence;
		} else {
			current = current ? `${current} ${sentence}` : sentence;
		}
	}
	if (current) parts.push(current);
	return parts;
}

function splitWords(sentence: string, max: number): string[] {
	const parts: string[] = [];
	let current = "";
	for (const word of sentence.split(/\s+/)) {
		if (current && current.length + 1 + word.length > max) {
			parts.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) parts.push(current);
	return parts;
}
