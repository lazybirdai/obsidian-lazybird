import { MarkdownView, Notice, type TFile } from "obsidian";
import { LazybirdError } from "./api";
import type LazybirdPlugin from "./main";
import { concatMp3 } from "./mp3";
import { noteToSpeechText, splitIntoChunks } from "./text";

/** Chunk size for saved audio. Bigger chunks mean fewer joins. */
const CHUNK_CHARS = 2000;
/** Chunks generated at the same time. */
const CONCURRENCY = 3;

/** Generates audio for the whole note, saves it as an attachment and embeds it at the top of the note. */
export async function saveNoteAsMp3(plugin: LazybirdPlugin, file: TFile, markdown: string): Promise<void> {
	const { app } = plugin;
	const text = noteToSpeechText(markdown);
	const chunks = splitIntoChunks(text, { maxChars: CHUNK_CHARS });
	if (chunks.length === 0) {
		new Notice("Nothing to read in this note.");
		return;
	}

	const progress = new Notice("Generating audio…", 0);
	try {
		let done = 0;
		const { voiceId, speed } = plugin.settings;
		const parts = await mapLimit(chunks, CONCURRENCY, async (chunk) => {
			const mp3 = await plugin.api.speak(chunk, voiceId, { speed });
			done++;
			if (chunks.length > 1) progress.setMessage(`Generating audio… ${done}/${chunks.length}`);
			return mp3;
		});

		const path = await app.fileManager.getAvailablePathForAttachment(`${file.basename}.mp3`, file.path);
		const mp3File = await app.vault.createBinary(path, concatMp3(parts));
		await insertEmbed(plugin, file, `!${app.fileManager.generateMarkdownLink(mp3File, file.path)}`);
		new Notice(`Saved ${mp3File.name}.`);
	} catch (error) {
		new Notice(error instanceof LazybirdError ? error.message : `Lazybird: couldn't save the audio (${String(error)}).`);
	} finally {
		progress.hide();
	}
}

/** Puts the embed on its own line after the note's frontmatter. */
async function insertEmbed(plugin: LazybirdPlugin, file: TFile, embed: string): Promise<void> {
	const { app } = plugin;
	const line = (app.metadataCache.getFileCache(file)?.frontmatterPosition?.end.line ?? -1) + 1;
	const view = app.workspace.getActiveViewOfType(MarkdownView);
	if (view?.file === file && view.getMode() === "source") {
		// Edit through the editor so the cursor and undo history stay intact.
		view.editor.replaceRange(`${embed}\n\n`, { line, ch: 0 });
		return;
	}
	await app.vault.process(file, (data) => {
		const lines = data.split("\n");
		lines.splice(line, 0, embed, "");
		return lines.join("\n");
	});
}

/** Like `Promise.all(items.map(fn))`, with at most `limit` calls running at once. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}
