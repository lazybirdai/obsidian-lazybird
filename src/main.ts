import { MarkdownView, Notice, Plugin, type TFile } from "obsidian";
import { LazybirdApi, type Voice } from "./api";
import { Player } from "./player";
import { saveNoteAsMp3 } from "./save";
import { DEFAULT_SETTINGS, type LazybirdSettings, LazybirdSettingTab } from "./settings";
import { noteToSpeechText } from "./text";

export default class LazybirdPlugin extends Plugin {
	settings: LazybirdSettings = { ...DEFAULT_SETTINGS };
	api = new LazybirdApi(() => this.getApiKey());
	private player!: Player;
	private voices: Promise<Voice[]> | null = null;
	private saving = false;

	async onload(): Promise<void> {
		this.settings = { ...DEFAULT_SETTINGS, ...((await this.loadData()) as Partial<LazybirdSettings> | null) };
		this.player = new Player(this, this.addStatusBarItem());
		this.addSettingTab(new LazybirdSettingTab(this.app, this));

		this.addCommand({
			id: "read-note-aloud",
			name: "Read note aloud",
			icon: "audio-lines",
			checkCallback: (checking) => {
				const file = this.activeNote();
				if (!file) return false;
				if (!checking) void this.readAloud(file);
				return true;
			},
		});

		this.addCommand({
			id: "read-selection-aloud",
			name: "Read selection aloud",
			icon: "text-select",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection();
				if (!selection.trim()) return false;
				if (!checking) this.speak(noteToSpeechText(selection));
				return true;
			},
		});

		this.addCommand({
			id: "save-note-as-mp3",
			name: "Save note as MP3",
			icon: "file-audio",
			checkCallback: (checking) => {
				const file = this.activeNote();
				if (!file || this.saving) return false;
				if (!checking) void this.saveAsMp3(file);
				return true;
			},
		});

		this.addCommand({
			id: "stop-playback",
			name: "Stop playback",
			icon: "square",
			checkCallback: (checking) => {
				if (!this.player.isActive) return false;
				if (!checking) this.player.stop();
				return true;
			},
		});
	}

	onunload(): void {
		this.player.stop();
	}

	/** The API key from Obsidian's keychain, or null when signed out. */
	getApiKey(): string | null {
		const id = this.settings.apiKeySecret;
		return id ? this.app.secretStorage.getSecret(id) || null : null;
	}

	async updateSettings(changes: Partial<LazybirdSettings>): Promise<void> {
		this.settings = { ...this.settings, ...changes };
		await this.saveData(this.settings);
		// The voice list includes the account's own voices, so it changes with the key.
		if ("apiKeySecret" in changes) this.voices = null;
	}

	/** The voice list, fetched once per session. */
	getVoices(): Promise<Voice[]> {
		this.voices ??= this.api.voices().catch((error: unknown) => {
			this.voices = null;
			throw error;
		});
		return this.voices;
	}

	private activeNote(): TFile | null {
		const file = this.app.workspace.getActiveFile();
		return file?.extension === "md" ? file : null;
	}

	/** The note's text, including edits the editor hasn't saved yet. */
	private async noteMarkdown(file: TFile): Promise<string> {
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		return view?.file === file ? view.editor.getValue() : this.app.vault.cachedRead(file);
	}

	private async readAloud(file: TFile): Promise<void> {
		this.speak(noteToSpeechText(await this.noteMarkdown(file)));
	}

	private speak(text: string): void {
		if (!this.getApiKey()) {
			new Notice("Sign in to Lazybird in the plugin's options first.");
			return;
		}
		this.player.play(text);
	}

	private async saveAsMp3(file: TFile): Promise<void> {
		if (!this.getApiKey()) {
			new Notice("Sign in to Lazybird in the plugin's options first.");
			return;
		}
		this.saving = true;
		try {
			await saveNoteAsMp3(this, file, await this.noteMarkdown(file));
		} finally {
			this.saving = false;
		}
	}
}
