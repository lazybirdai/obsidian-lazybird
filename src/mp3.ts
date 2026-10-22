/**
 * Joins MP3 files into one, so a long note saves as a single audio file.
 *
 * Each part's tags and Xing/Info frame are dropped and its audio frames are
 * appended in order. One new Xing frame at the start gives players the total
 * length, so the duration shows and seeking works.
 *
 * Pure functions with no Obsidian imports, so they run under `node --test`.
 */

interface FrameInfo {
	/** Byte length of the whole frame. */
	length: number;
	/** Offset of the Xing/Info tag inside the frame. */
	xingOffset: number;
}

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SAMPLE_RATES: Record<number, number[]> = {
	3: [44100, 48000, 32000], // MPEG 1
	2: [22050, 24000, 16000], // MPEG 2
	0: [11025, 12000, 8000], // MPEG 2.5
};

/** Reads an MPEG audio Layer III frame header at `pos`, or returns null. */
function readFrame(data: Uint8Array, pos: number): FrameInfo | null {
	if (pos + 4 > data.length) return null;
	const b1 = data[pos + 1] ?? 0;
	const b2 = data[pos + 2] ?? 0;
	const b3 = data[pos + 3] ?? 0;
	if (data[pos] !== 0xff || (b1 & 0xe0) !== 0xe0) return null;
	const version = (b1 >> 3) & 0x03;
	const layer = (b1 >> 1) & 0x03;
	if (version === 1 || layer !== 1) return null;
	const bitrateIndex = (b2 >> 4) & 0x0f;
	const sampleRateIndex = (b2 >> 2) & 0x03;
	const padding = (b2 >> 1) & 0x01;
	const bitrate = (version === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex];
	const sampleRate = SAMPLE_RATES[version]?.[sampleRateIndex];
	if (!bitrate || !sampleRate) return null;
	const samplesFactor = version === 3 ? 144 : 72;
	const length = Math.floor((samplesFactor * bitrate * 1000) / sampleRate) + padding;
	const mono = (b3 >> 6) === 3;
	const sideInfo = version === 3 ? (mono ? 17 : 32) : mono ? 9 : 17;
	const crc = (b1 & 0x01) === 0 ? 2 : 0;
	return { length, xingOffset: 4 + crc + sideInfo };
}

function isXingFrame(data: Uint8Array, pos: number, frame: FrameInfo): boolean {
	const at = pos + frame.xingOffset;
	const tag = String.fromCharCode(data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0, data[at + 3] ?? 0);
	return tag === "Xing" || tag === "Info";
}

/** Skips an ID3v2 tag at the start of the file. */
function audioStart(data: Uint8Array): number {
	if (data.length < 10 || data[0] !== 0x49 || data[1] !== 0x44 || data[2] !== 0x33) return 0;
	const size = (((data[6] ?? 0) & 0x7f) << 21) | (((data[7] ?? 0) & 0x7f) << 14) | (((data[8] ?? 0) & 0x7f) << 7) | ((data[9] ?? 0) & 0x7f);
	const footer = ((data[5] ?? 0) & 0x10) !== 0 ? 10 : 0;
	return 10 + size + footer;
}

interface Part {
	data: Uint8Array;
	/** Start offsets of audio frames, without the Xing/Info frame. */
	frames: number[];
	end: number;
	/** First frame of the file, Xing/Info or not, used as the template for the new Xing frame. */
	firstFrame: { pos: number; info: FrameInfo } | null;
}

function scan(data: Uint8Array): Part {
	let pos = audioStart(data);
	// Some encoders pad before the first frame; find the first sync.
	while (pos < data.length && !readFrame(data, pos)) pos++;
	const frames: number[] = [];
	let firstFrame: Part["firstFrame"] = null;
	for (;;) {
		const info = readFrame(data, pos);
		if (!info || pos + info.length > data.length) break;
		if (!firstFrame) firstFrame = { pos, info };
		if (!(frames.length === 0 && isXingFrame(data, pos, info))) frames.push(pos);
		pos += info.length;
	}
	return { data, frames, end: pos, firstFrame };
}

/** Joins MP3 files into one. Returns the input unchanged when there is only one. */
export function concatMp3(files: ArrayBuffer[]): ArrayBuffer {
	if (files.length === 1 && files[0]) return files[0];
	const parts = files.map((file) => scan(new Uint8Array(file)));
	const template = parts.find((p) => p.firstFrame)?.firstFrame;
	if (!template) throw new Error("No MP3 audio found");
	const templatePart = parts.find((p) => p.firstFrame === template);
	if (!templatePart) throw new Error("No MP3 audio found");

	// Audio bytes per part: from its first audio frame to its last frame end.
	const ranges = parts
		.filter((p) => p.frames.length > 0)
		.map((p) => ({ data: p.data, start: p.frames[0] ?? 0, end: p.end, frames: p.frames }));
	// The new Xing frame copies the first frame's header at the top bitrate,
	// which leaves room for the tag and seek table.
	const header = templatePart.data.slice(template.pos, template.pos + 4);
	header[1] = (header[1] ?? 0) | 0x01; // no CRC
	header[2] = (((header[2] ?? 0) & 0x0d) | (14 << 4)) & 0xff;
	const xingInfo = readFrame(header, 0);
	if (!xingInfo) throw new Error("No MP3 audio found");
	const xingLength = xingInfo.length;
	const audioBytes = ranges.reduce((sum, r) => sum + (r.end - r.start), 0);
	const totalBytes = xingLength + audioBytes;
	const frameCount = ranges.reduce((sum, r) => sum + r.frames.length, 0);

	// Byte offset of every frame in the output, for the seek table.
	const offsets: number[] = [];
	let base = xingLength;
	for (const r of ranges) {
		for (const f of r.frames) offsets.push(base + (f - r.start));
		base += r.end - r.start;
	}

	const out = new Uint8Array(totalBytes);
	// New Xing frame: the template frame's header, silent side info, then the tag.
	out.set(header, 0);
	const view = new DataView(out.buffer);
	let at = xingInfo.xingOffset;
	for (const c of "Xing") out[at++] = c.charCodeAt(0);
	view.setUint32(at, 0x0007, false); // frames, bytes and seek table present
	view.setUint32(at + 4, frameCount, false);
	view.setUint32(at + 8, totalBytes, false);
	for (let i = 0; i < 100; i++) {
		const offset = offsets[Math.floor((i / 100) * frameCount)] ?? 0;
		out[at + 12 + i] = Math.min(255, Math.floor((offset / totalBytes) * 256));
	}

	let pos = xingLength;
	for (const r of ranges) {
		out.set(r.data.subarray(r.start, r.end), pos);
		pos += r.end - r.start;
	}
	return out.buffer;
}
