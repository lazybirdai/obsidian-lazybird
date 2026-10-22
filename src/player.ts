import { Notice, setIcon, setTooltip } from "obsidian";
import { LazybirdError } from "./api";
import type LazybirdPlugin from "./main";
import { splitIntoChunks } from "./text";

/** A short first chunk starts playback sooner; later chunks grow up to this size. */
const FIRST_CHUNK_CHARS = 200;
const MAX_CHUNK_CHARS = 1000;
/** Chunks generated ahead of the one playing. */
const LOOKAHEAD = 2;

type State = "idle" | "loading" | "playing" | "paused";

interface Clip {
	/** Blob URL of the chunk's MP3. */
	url: Promise<string>;
	ready: boolean;
}

/**
 * Reads text aloud chunk by chunk, generating the next chunks while the
 * current one plays. Its controls live in the status bar.
 */
export class Player {
	private state: State = "idle";
	private readonly audio = new Audio();
	private chunks: string[] = [];
	private clips: Clip[] = [];
	private index = 0;
	/** Bumped on every new run so stale callbacks from an old one do nothing. */
	private run = 0;

	private readonly statusEl: HTMLElement;
	private readonly playPauseEl: HTMLElement;
	private readonly labelEl: HTMLElement;

	constructor(
		private readonly plugin: LazybirdPlugin,
		statusBarEl: HTMLElement,
	) {
		this.statusEl = statusBarEl;
		this.statusEl.addClass("lazybird-player");
		this.playPauseEl = this.statusEl.createSpan({ cls: "lazybird-player-button" });
		const stopEl = this.statusEl.createSpan({ cls: "lazybird-player-button" });
		this.labelEl = this.statusEl.createSpan({ cls: "lazybird-player-label" });
		setIcon(stopEl, "square");
		setTooltip(stopEl, "Stop", { placement: "top" });
		plugin.registerDomEvent(this.playPauseEl, "click", () => this.togglePause());
		plugin.registerDomEvent(stopEl, "click", () => this.stop());
		plugin.registerDomEvent(this.audio, "ended", () => {
			if (this.state === "playing") void this.playChunk(this.index + 1);
		});
		this.render();
	}

	get isActive(): boolean {
		return this.state !== "idle";
	}

	/** Starts reading `text` aloud, replacing anything already playing. */
	play(text: string): void {
		this.stop();
		this.chunks = splitIntoChunks(text, { maxChars: MAX_CHUNK_CHARS, firstChunkChars: FIRST_CHUNK_CHARS });
		if (this.chunks.length === 0) {
			new Notice("Nothing to read.");
			return;
		}
		void this.playChunk(0);
	}

	togglePause(): void {
		if (this.state === "playing") {
			this.audio.pause();
			this.setState("paused");
		} else if (this.state === "paused") {
			void this.audio.play();
			this.setState("playing");
		}
	}

	stop(): void {
		this.run++;
		this.audio.pause();
		this.audio.removeAttribute("src");
		for (const clip of this.clips) void clip.url.then((url) => URL.revokeObjectURL(url), () => undefined);
		this.clips = [];
		this.chunks = [];
		this.setState("idle");
	}

	private async playChunk(index: number): Promise<void> {
		const run = this.run;
		if (index >= this.chunks.length) {
			this.stop();
			return;
		}
		this.index = index;
		for (let i = index; i <= index + LOOKAHEAD && i < this.chunks.length; i++) this.fetchClip(i);
		const clip = this.clips[index];
		if (!clip) return;

		if (!clip.ready) this.setState("loading");
		let url: string;
		try {
			url = await clip.url;
		} catch (error) {
			if (run !== this.run) return;
			new Notice(error instanceof LazybirdError ? error.message : `Lazybird: ${String(error)}`);
			this.stop();
			return;
		}
		if (run !== this.run) return;
		// The previous chunk's audio is done with; free it.
		void this.clips[index - 1]?.url.then((u) => URL.revokeObjectURL(u), () => undefined);

		this.audio.src = url;
		try {
			await this.audio.play();
			this.setState("playing");
		} catch (error) {
			if (run !== this.run) return;
			new Notice(`Lazybird: couldn't play audio (${String(error)}).`);
			this.stop();
		}
	}

	private fetchClip(index: number): void {
		if (this.clips[index]) return;
		const text = this.chunks[index] ?? "";
		const { voiceId, speed } = this.plugin.settings;
		const clip: Clip = {
			ready: false,
			url: this.plugin.api.speak(text, voiceId, { speed }).then((mp3) => {
				clip.ready = true;
				return URL.createObjectURL(new Blob([mp3], { type: "audio/mpeg" }));
			}),
		};
		// Errors surface when the chunk's turn comes; don't report them twice.
		clip.url.catch(() => undefined);
		this.clips[index] = clip;
	}

	private setState(state: State): void {
		this.state = state;
		this.render();
	}

	private render(): void {
		this.statusEl.toggleClass("is-hidden", this.state === "idle");
		const part = this.chunks.length > 1 ? ` ${this.index + 1}/${this.chunks.length}` : "";
		if (this.state === "loading") {
			setIcon(this.playPauseEl, "loader");
			setTooltip(this.playPauseEl, "Generating audio", { placement: "top" });
			this.labelEl.setText(`Generating${part}`);
		} else {
			const playing = this.state === "playing";
			setIcon(this.playPauseEl, playing ? "pause" : "play");
			setTooltip(this.playPauseEl, playing ? "Pause" : "Resume", { placement: "top" });
			this.labelEl.setText(`Lazybird${part}`);
		}
	}
}
