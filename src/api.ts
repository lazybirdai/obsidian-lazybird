import { requestUrl, type RequestUrlResponse } from "obsidian";

export const API_BASE = "https://api.lazybird.app/v1";
export const PRICING_URL = "https://lazybird.app/pricing";
export const ACCOUNT_URL = "https://lazybird.app/studio/settings";

export interface Voice {
	id: string;
	displayName: string;
	/** Locale such as "en-US". */
	language?: string;
	gender?: string;
	description?: string;
	/** "global" for the Lazybird library, "community" for voices shared by users. */
	scope?: string;
	languageGroup?: string;
	/** True for the account's own voices. */
	mine?: boolean;
}

export interface Account {
	email: string;
	plan: { tier: string; name: string; isPaid: boolean };
	credits: { used: number; limit: number; extraCredits: number; remaining: number; resetsAt?: string };
}

export interface SpeechSettings {
	speed: number;
}

/** An API error with a message written for the person using the plugin. */
export class LazybirdError extends Error {
	constructor(
		message: string,
		readonly status: number,
		/** Seconds to wait before retrying, for 429 responses. */
		readonly retryAfter?: number,
	) {
		super(message);
		this.name = "LazybirdError";
	}
}

export class LazybirdApi {
	constructor(private readonly getKey: () => string | null) {}

	async requestCode(email: string): Promise<void> {
		await this.call("POST", "/auth/request-code", { email }, false);
	}

	/** Trades the emailed code for a new API key. */
	async verifyCode(email: string, code: string): Promise<{ apiKey: string; email: string; isNewAccount: boolean }> {
		const response = await this.call("POST", "/auth/verify-code", { email, code, keyName: "Obsidian" }, false);
		return response.json as { apiKey: string; email: string; isNewAccount: boolean };
	}

	async me(): Promise<Account> {
		return (await this.call("GET", "/me")).json as Account;
	}

	/** The Lazybird voice library, plus the account's own voices when signed in. */
	async voices(): Promise<Voice[]> {
		const all = (await this.call("GET", "/voices", undefined, false)).json as Voice[];
		const library = all.filter((v) => v.scope === "global");
		if (!this.getKey()) return library;
		const own = (await this.call("GET", "/voices?owner=me")).json as Voice[];
		const ownIds = new Set(own.map((v) => v.id));
		return [...own.map((v) => ({ ...v, mine: true })), ...library.filter((v) => !ownIds.has(v.id))];
	}

	/** Speaks `text` and returns MP3 audio. */
	async speak(text: string, voiceId: string, settings: SpeechSettings): Promise<ArrayBuffer> {
		const body: Record<string, unknown> = { voiceId, text };
		if (settings.speed !== 1) body.settings = { speed: settings.speed };
		return (await this.call("POST", "/generate-speech", body)).arrayBuffer;
	}

	private async call(method: string, path: string, body?: unknown, auth = true): Promise<RequestUrlResponse> {
		const headers: Record<string, string> = {};
		if (auth) {
			const key = this.getKey();
			if (!key) throw new LazybirdError("Sign in to Lazybird in the plugin's options first.", 401);
			headers["X-API-Key"] = key;
		}
		let response: RequestUrlResponse;
		try {
			response = await requestUrl({
				url: API_BASE + path,
				method,
				headers,
				contentType: body === undefined ? undefined : "application/json",
				body: body === undefined ? undefined : JSON.stringify(body),
				throw: false,
			});
		} catch {
			throw new LazybirdError("Couldn't reach Lazybird. Check your internet connection.", 0);
		}
		if (response.status >= 400) throw toError(response);
		return response;
	}
}

function toError(response: RequestUrlResponse): LazybirdError {
	const { status } = response;
	let message = "";
	let retryAfter: number | undefined;
	try {
		const json = response.json as { error?: string; retryAfterSeconds?: number } | null;
		message = (json?.error ?? "").replace(/^[A-Za-z ]+Error: /, "");
		retryAfter = json?.retryAfterSeconds;
	} catch {
		// Not JSON; fall back to the status below.
	}
	const header = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
	retryAfter ??= header ? Number(header) || undefined : undefined;

	switch (status) {
		case 401:
			return new LazybirdError("Your Lazybird API key isn't valid. Sign in again in the plugin's options.", status);
		case 422:
			return new LazybirdError(
				/credit/i.test(message)
					? "You're out of Lazybird credits. Get more at lazybird.app/pricing, or wait for your monthly credits to reset."
					: `${message || "Your plan doesn't allow this request."} See lazybird.app/pricing.`,
				status,
			);
		case 429:
			return new LazybirdError(
				retryAfter ? `Too many requests. Try again in ${retryAfter} seconds.` : "Too many requests. Try again shortly.",
				status,
				retryAfter,
			);
		case 503:
			return new LazybirdError("Lazybird is busy right now. Try again in a minute.", status);
		default:
			return new LazybirdError(message || `Lazybird request failed (${status}).`, status);
	}
}
