import { type App, Notice, PluginSettingTab, type SettingDefinitionItem } from "obsidian";
import { ACCOUNT_URL, type Account, LazybirdError } from "./api";
import type LazybirdPlugin from "./main";
import { VoiceSuggestModal } from "./voices";

export interface LazybirdSettings {
	/** Name of the secret in Obsidian's keychain that holds the API key. */
	apiKeySecret: string;
	voiceId: string;
	voiceName: string;
	speed: number;
}

export const DEFAULT_SETTINGS: LazybirdSettings = {
	apiKeySecret: "",
	voiceId: "msa.en-US.AvaMultilingual",
	voiceName: "Ava",
	speed: 1,
};

/** Secret the email sign-in saves its key under. */
export const SIGN_IN_SECRET = "lazybird-api-key";

export class LazybirdSettingTab extends PluginSettingTab {
	private email = "";
	private code = "";
	private codeSentTo = "";
	private busy = false;
	private account: Account | null = null;
	private accountError = "";
	/** The account is fetched once each time the tab opens. */
	private accountLoad: Promise<void> | null = null;

	constructor(
		app: App,
		private readonly plugin: LazybirdPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const signedIn = () => this.plugin.getApiKey() !== null;
		return [
			{
				type: "group",
				heading: "Account",
				items: [
					{
						name: "Signed in",
						visible: signedIn,
						render: (setting) => {
							this.accountLoad ??= this.refreshAccount();
							setting.setDesc(this.accountSummary());
							setting.addButton((button) =>
								button.setButtonText("Manage account").onClick(() => window.open(ACCOUNT_URL)),
							);
							setting.addButton((button) =>
								button.setButtonText("Sign out").onClick(() => void this.signOut()),
							);
						},
					},
					{
						name: "Email",
						desc: "Sign in or create a free account. We'll email you a 6-digit code.",
						visible: () => !signedIn(),
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder("you@example.com")
									.setValue(this.email)
									.onChange((value) => (this.email = value.trim())),
							);
							setting.addButton((button) =>
								button
									.setButtonText(this.codeSentTo ? "Send again" : "Send code")
									.setCta()
									.setDisabled(this.busy)
									.onClick(() => void this.sendCode()),
							);
						},
					},
					{
						name: "Code",
						desc: this.codeSentTo ? `Enter the code we sent to ${this.codeSentTo}.` : "",
						visible: () => !signedIn() && this.codeSentTo !== "",
						render: (setting) => {
							setting.addText((text) =>
								text
									.setPlaceholder("123456")
									.setValue(this.code)
									.onChange((value) => (this.code = value.trim())),
							);
							setting.addButton((button) =>
								button
									.setButtonText("Sign in")
									.setCta()
									.setDisabled(this.busy)
									.onClick(() => void this.verifyCode()),
							);
						},
					},
					{
						name: "API key",
						desc: "Or use an API key from your Lazybird account settings. It's kept in Obsidian's keychain.",
						control: { type: "secret", key: "apiKeySecret" },
					},
				],
			},
			{
				type: "group",
				heading: "Voice",
				items: [
					{
						name: "Voice",
						desc: this.plugin.settings.voiceName,
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText("Choose voice").onClick(() => this.chooseVoice()),
							);
						},
					},
					{
						name: "Speed",
						desc: "1 is normal speed.",
						control: { type: "slider", key: "speed", min: 0.5, max: 2, step: 0.1, defaultValue: 1 },
					},
				],
			},
		];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		await this.plugin.updateSettings({ [key]: value });
		if (key === "apiKeySecret") {
			this.account = null;
			this.accountError = "";
			this.accountLoad = null;
			this.update();
		}
	}

	hide(): void {
		super.hide();
		this.accountLoad = null;
	}

	private accountSummary(): string {
		if (this.accountError) return this.accountError;
		if (!this.account) return "Checking your account…";
		const { email, plan, credits } = this.account;
		return `${email} · ${plan.name} plan · ${credits.remaining.toLocaleString()} credits left`;
	}

	private async refreshAccount(): Promise<void> {
		try {
			this.account = await this.plugin.api.me();
			this.accountError = "";
		} catch (error) {
			this.account = null;
			this.accountError = error instanceof Error ? error.message : String(error);
		}
		this.update();
	}

	private async sendCode(): Promise<void> {
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(this.email)) {
			new Notice("Enter your email address.");
			return;
		}
		await this.withBusy(async () => {
			await this.plugin.api.requestCode(this.email);
			this.codeSentTo = this.email;
			new Notice(`Code sent to ${this.email}. Check your inbox.`);
		});
	}

	private async verifyCode(): Promise<void> {
		if (!/^\d{6}$/.test(this.code)) {
			new Notice("Enter the 6-digit code from the email.");
			return;
		}
		await this.withBusy(async () => {
			const result = await this.plugin.api.verifyCode(this.codeSentTo, this.code);
			this.app.secretStorage.setSecret(SIGN_IN_SECRET, result.apiKey);
			await this.plugin.updateSettings({ apiKeySecret: SIGN_IN_SECRET });
			this.code = "";
			this.codeSentTo = "";
			new Notice(result.isNewAccount ? "Your free Lazybird account is ready." : "Signed in to Lazybird.");
			this.accountLoad = null;
		});
	}

	private async signOut(): Promise<void> {
		// Only clear the key the email sign-in saved; a key the user picked stays in their keychain.
		if (this.plugin.settings.apiKeySecret === SIGN_IN_SECRET) {
			this.app.secretStorage.setSecret(SIGN_IN_SECRET, "");
		}
		await this.plugin.updateSettings({ apiKeySecret: "" });
		this.account = null;
		this.accountError = "";
		this.accountLoad = null;
		this.update();
	}

	private chooseVoice(): void {
		new VoiceSuggestModal(this.app, this.plugin, async (voice) => {
			await this.plugin.updateSettings({ voiceId: voice.id, voiceName: voice.displayName });
			this.update();
		}).open();
	}

	private async withBusy(run: () => Promise<void>): Promise<void> {
		this.busy = true;
		this.update();
		try {
			await run();
		} catch (error) {
			new Notice(error instanceof LazybirdError ? error.message : `Lazybird: ${String(error)}`);
		} finally {
			this.busy = false;
			this.update();
		}
	}
}
