import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { noteToSpeechText, splitIntoChunks } from "../src/text.ts";

describe("noteToSpeechText", () => {
	it("drops frontmatter", () => {
		assert.equal(noteToSpeechText("---\ntags: [a]\ntitle: x\n---\nHello there."), "Hello there.");
	});

	it("keeps a horizontal rule that isn't frontmatter out of the text", () => {
		assert.equal(noteToSpeechText("One.\n\n---\n\nTwo."), "One.\n\nTwo.");
	});

	it("drops code blocks, math and comments", () => {
		const note = [
			"Before.",
			"```js",
			"const x = 1;",
			"```",
			"~~~",
			"tilde code",
			"~~~",
			"$$",
			"e = mc^2",
			"$$",
			"%% hidden %%",
			"<!-- hidden too -->",
			"After.",
		].join("\n");
		assert.equal(noteToSpeechText(note), "Before.\n\nAfter.");
	});

	it("keeps link text and drops embeds", () => {
		const note = "See [[Projects/Plan.md|the plan]], [[Ideas]] and [[#Goals]]. ![[photo.png]] ![alt](a.png) Read [the docs](https://x.y).";
		assert.equal(noteToSpeechText(note), "See the plan, Ideas and Goals. Read the docs.");
	});

	it("drops bare URLs and footnote markers", () => {
		assert.equal(noteToSpeechText("Visit https://lazybird.app today.[^1]"), "Visit today.");
	});

	it("strips Markdown syntax", () => {
		const note = [
			"# Big heading",
			"## Ends with question?",
			"> [!note] Callout title",
			"> Quoted **bold** and *italic* and _under_ and ~~gone~~ and ==marked==.",
			"- [ ] Task item ^block-1",
			"1. Numbered `code` item #tag",
		].join("\n");
		assert.equal(
			noteToSpeechText(note),
			[
				"Big heading.",
				"Ends with question?",
				"Callout title.",
				"Quoted bold and italic and under and gone and marked.",
				"Task item",
				"Numbered code item tag",
			].join("\n"),
		);
	});

	it("reads tables as lists of cells", () => {
		const note = "| Name | Age |\n| --- | :-: |\n| Ann | 30 |";
		assert.equal(noteToSpeechText(note), "Name, Age\nAnn, 30");
	});

	it("strips HTML and decodes entities", () => {
		assert.equal(noteToSpeechText("<div>Fish &amp; chips&#33;</div>"), "Fish & chips!");
	});

	it("leaves snake_case and math-like asterisks alone", () => {
		assert.equal(noteToSpeechText("Use my_var_name and 2 * 3 * 4."), "Use my_var_name and 2 * 3 * 4.");
	});
});

describe("splitIntoChunks", () => {
	const sentence = (n: number) => `This is sentence number ${n}.`;

	it("returns no chunks for empty text", () => {
		assert.deepEqual(splitIntoChunks("  \n ", { maxChars: 100 }), []);
	});

	it("keeps short text in one chunk", () => {
		assert.deepEqual(splitIntoChunks("Hello.\nWorld.", { maxChars: 100 }), ["Hello.\nWorld."]);
	});

	it("never exceeds the limit and keeps every word in order", () => {
		const text = Array.from({ length: 60 }, (_, i) => sentence(i)).join(" ") + "\n" + "word ".repeat(80).trim();
		const chunks = splitIntoChunks(text, { maxChars: 120 });
		for (const chunk of chunks) assert.ok(chunk.length <= 120, `chunk too long: ${chunk.length}`);
		assert.equal(chunks.join(" ").replace(/\s+/g, " "), text.replace(/\s+/g, " "));
	});

	it("splits at sentence ends", () => {
		const text = Array.from({ length: 10 }, (_, i) => sentence(i)).join(" ");
		for (const chunk of splitIntoChunks(text, { maxChars: 80 })) assert.match(chunk, /\.$/);
	});

	it("starts small and grows to the maximum", () => {
		const text = Array.from({ length: 200 }, (_, i) => sentence(i)).join(" ");
		const chunks = splitIntoChunks(text, { maxChars: 1000, firstChunkChars: 200 });
		const lengths = chunks.map((c) => c.length);
		assert.ok((lengths[0] ?? 0) <= 200);
		assert.ok((lengths[1] ?? 0) <= 400 && (lengths[1] ?? 0) > 200);
		assert.ok((lengths[2] ?? 0) <= 800 && (lengths[2] ?? 0) > 400);
		assert.ok(lengths.slice(3, -1).every((n) => n <= 1000 && n > 900));
	});

	it("passes a single word longer than the limit through whole", () => {
		const long = "x".repeat(50);
		assert.deepEqual(splitIntoChunks(`Hi. ${long} bye.`, { maxChars: 20 }), ["Hi.", long, "bye."]);
	});

	it("joins paragraphs with a line break", () => {
		assert.deepEqual(splitIntoChunks("One.\n\nTwo.\nThree.", { maxChars: 100 }), ["One.\nTwo.\nThree."]);
	});
});
