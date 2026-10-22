import { type App, type FuzzyMatch, FuzzySuggestModal, getLanguage, Notice } from "obsidian";
import { LazybirdError, type Voice } from "./api";
import type LazybirdPlugin from "./main";

/** Lists the account's own voices, then the Lazybird voice library, and returns the one picked. */
export class VoiceSuggestModal extends FuzzySuggestModal<Voice> {
	private voices: Voice[] = [];
	private readonly languageNames = new Intl.DisplayNames([getLanguage(), "en"], { type: "language" });

	constructor(
		app: App,
		private readonly plugin: LazybirdPlugin,
		private readonly onChoose: (voice: Voice) => void | Promise<void>,
	) {
		super(app);
		this.setPlaceholder("Search voices by name or language");
		this.emptyStateText = "Loading voices…";
	}

	onOpen(): void {
		void super.onOpen();
		void this.load();
	}

	private async load(): Promise<void> {
		try {
			this.voices = sortVoices(await this.plugin.getVoices());
			this.emptyStateText = "No voices match.";
		} catch (error) {
			this.emptyStateText = error instanceof LazybirdError ? error.message : "Couldn't load voices.";
		}
		// Re-run the search so the list fills in.
		this.inputEl.dispatchEvent(new Event("input"));
	}

	getItems(): Voice[] {
		return this.voices;
	}

	getItemText(voice: Voice): string {
		return [voice.displayName, this.languageName(voice), voice.description ?? "", voice.gender ?? ""].join(" ");
	}

	renderSuggestion(match: FuzzyMatch<Voice>, el: HTMLElement): void {
		const voice = match.item;
		el.addClass("lazybird-voice");
		el.createDiv({ cls: "lazybird-voice-name", text: voice.displayName });
		const details = [
			voice.mine ? "Your voice" : "",
			this.languageName(voice),
			voice.languageGroup === "multilingual" ? "multilingual" : "",
			voice.gender === "unknown" ? "" : (voice.gender ?? ""),
		].filter(Boolean);
		el.createDiv({ cls: "lazybird-voice-details", text: details.join(" · ") });
		if (voice.id === this.plugin.settings.voiceId) el.addClass("is-current");
	}

	onChooseItem(voice: Voice): void {
		void Promise.resolve(this.onChoose(voice)).catch((error) => new Notice(`Lazybird: ${String(error)}`));
	}

	private languageName(voice: Voice): string {
		if (!voice.language) return "";
		try {
			return this.languageNames.of(voice.language) ?? voice.language;
		} catch {
			return voice.language;
		}
	}
}

/** Own voices first, then multilingual voices, then by language and name. */
function sortVoices(voices: Voice[]): Voice[] {
	const rank = (v: Voice) => (v.mine ? 0 : v.languageGroup === "multilingual" ? 1 : 2);
	return [...voices].sort(
		(a, b) =>
			rank(a) - rank(b) ||
			(a.language ?? "").localeCompare(b.language ?? "") ||
			a.displayName.localeCompare(b.displayName),
	);
}
