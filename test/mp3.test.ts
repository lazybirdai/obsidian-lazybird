import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { concatMp3 } from "../src/mp3.ts";

const fixture = (name: string): ArrayBuffer => {
	const data = readFileSync(join(import.meta.dirname, "fixtures", name));
	return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
};

/** Duration from ffprobe, or null when ffprobe isn't installed. */
function probe(mp3: ArrayBuffer): number | null {
	const file = join(mkdtempSync(join(tmpdir(), "lazybird-")), "out.mp3");
	writeFileSync(file, new Uint8Array(mp3));
	try {
		const out = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
		return Number(out.toString().trim());
	} catch {
		return null;
	}
}

describe("concatMp3", () => {
	it("returns a single file unchanged", () => {
		const speech = fixture("speech.mp3");
		assert.equal(concatMp3([speech]), speech);
	});

	it("joins files into one with a Xing header", () => {
		const speech = fixture("speech.mp3");
		const tone = fixture("tone.mp3");
		const out = new Uint8Array(concatMp3([speech, tone, speech]));
		assert.equal(out[0], 0xff);
		const text = new TextDecoder("latin1").decode(out.subarray(0, 64));
		assert.ok(text.includes("Xing"), "Xing tag at the start");
		// Neither input's ID3 tag survives.
		assert.equal(new TextDecoder("latin1").decode(out).indexOf("ID3"), -1);
		assert.ok(out.length < speech.byteLength * 2 + tone.byteLength);
	});

	it("adds up the durations", (t) => {
		const speech = fixture("speech.mp3");
		const tone = fixture("tone.mp3");
		const parts = [probe(speech), probe(tone)];
		const joined = probe(concatMp3([speech, tone, speech]));
		if (joined === null || parts.includes(null)) {
			t.skip("ffprobe not installed");
			return;
		}
		const expected = (parts[0] ?? 0) * 2 + (parts[1] ?? 0);
		assert.ok(Math.abs(joined - expected) < 0.2, `joined ${joined}s, expected about ${expected}s`);
	});
});
