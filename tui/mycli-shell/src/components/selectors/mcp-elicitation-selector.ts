import { stripVTControlCharacters } from "node:util";
import type { McpElicitationField, McpElicitationRequest } from "@mycli/contracts";
import { Container, Input, getKeybindings, matchesKey } from "../../tui-core/index.ts";
import { wrapTextWithAnsi } from "../../tui-core/utils.ts";
import { safeErrorMessage } from "../../safe-ui-text.ts";
import { theme } from "../../theme/theme.ts";
import { DecisionPanel, type DecisionPanelOptions } from "./decision-panel.ts";

type FormValue = string | number | boolean | string[];

export interface McpElicitationSelectorOptions extends DecisionPanelOptions {
	readonly request: McpElicitationRequest;
	readonly onRespond: (response: string) => void | Promise<void>;
}

/** A live MCP form, with one field per page and a final explicit submission. */
export class McpElicitationSelectorComponent extends Container {
	readonly #panel: DecisionPanel;
	readonly #input = new Input();
	readonly #answers: Record<string, FormValue> = Object.create(null) as Record<string, FormValue>;
	readonly #selectedValues = new Set<string>();
	#fieldIndex = 0;
	#selected = 0;
	#busy = false;
	#error = "";

	constructor(readonly options: McpElicitationSelectorOptions) {
		super();
		this.#panel = new DecisionPanel(options);
		this.addChild(this.#panel);
		this.#loadField();
	}

	handleInput(data: string): void {
		if (this.#busy || this.#panel.handleInput(data)) return;
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) { this.#respond("cancel"); return; }
		if (matchesKey(data, "shift+tab")) {
			this.#fieldIndex = Math.max(0, this.#fieldIndex - 1); this.#loadField(); return;
		}
		const field = this.#field();
		if (field && !field.required && matchesKey(data, "tab")) {
			delete this.#answers[field.name]; this.#nextField(); return;
		}
		const choices = this.#choices();
		if (field && choices.length === 0) {
			if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
				const text = this.#input.getValue();
				const value = field.type === "number" || field.type === "integer" ? (text.trim() ? Number(text) : NaN) : text;
				this.#saveField(value);
			} else {
				this.#input.handleInput(data);
				if (this.#input.getValue().length > 4_096) this.#input.setValue(this.#input.getValue().slice(0, 4_096));
				this.#render();
			}
			return;
		}
		if (kb.matches(data, "tui.select.up") || data === "k") this.#selected = Math.max(0, this.#selected - 1);
		else if (kb.matches(data, "tui.select.down") || data === "j") this.#selected = Math.min(choices.length - 1, this.#selected + 1);
		else if (field?.type === "array" && matchesKey(data, "space")) {
			const value = choices[this.#selected]?.value;
			if (value !== undefined) this.#selectedValues.has(value) ? this.#selectedValues.delete(value) : this.#selectedValues.add(value);
		} else if (kb.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") {
			if (field) {
				const value = choices[this.#selected]?.value;
				this.#saveField(field.type === "array" ? [...this.#selectedValues] : field.type === "boolean" ? value === "true" : value ?? "");
			} else if (this.#selected === 0) this.#respond("accept");
			else if (this.#selected === 1 && this.options.request.fields.length) { this.#fieldIndex = 0; this.#loadField(); }
			else this.#respond("decline");
			return;
		}
		this.#render();
	}

	#field(): McpElicitationField | undefined { return this.options.request.fields[this.#fieldIndex]; }
	#choices(): { value: string; label: string }[] {
		const field = this.#field();
		if (!field) return [
			{ value: "accept", label: this.options.request.mode === "url" ? "Continue" : "Submit to server" },
			...(this.options.request.fields.length ? [{ value: "edit", label: "Edit answers" }] : []),
			{ value: "decline", label: "Decline request" },
		];
		if (field.type === "boolean") return [{ value: "true", label: "Yes" }, { value: "false", label: "No" }];
		return field.options ?? [];
	}
	#saveField(value: FormValue): void {
		const field = this.#field()!;
		this.#error = validateField(field, value);
		if (this.#error) { this.#render(); return; }
		this.#answers[field.name] = value;
		this.#nextField();
	}
	#nextField(): void { this.#fieldIndex += 1; this.#loadField(); }
	#loadField(): void {
		this.#selected = 0; this.#error = ""; this.#selectedValues.clear();
		const field = this.#field();
		const value = field ? this.#answers[field.name] ?? field.defaultValue : undefined;
		if (Array.isArray(value)) value.forEach((entry) => this.#selectedValues.add(entry));
		this.#input.setValue(value === undefined || Array.isArray(value) ? "" : String(value));
		this.#input.focused = true;
		const index = this.#choices().findIndex((choice) => choice.value === String(value));
		if (index >= 0) this.#selected = index;
		this.#render();
	}
	#respond(action: "accept" | "decline" | "cancel"): void {
		this.#busy = true; this.#error = ""; this.#render();
		const response = JSON.stringify({ action,
			...(action === "accept" && this.options.request.mode === "form" ? { content: this.#answers } : {}) });
		void Promise.resolve().then(() => this.options.onRespond(response)).catch((error: unknown) => {
			this.#busy = false;
			this.#error = safeErrorMessage(error, "The MCP response could not be submitted.");
			this.#render();
		});
	}
	#render(): void {
		const request = this.options.request;
		const field = this.#field();
		const choices = this.#choices();
		const details = [plain(request.message)];
		if (request.url) details.push("", "Open this URL in your browser, then continue:", plain(request.url));
		if (field) details.push("", `${this.#fieldIndex + 1}/${request.fields.length} · ${plain(field.label)}${field.required ? " (required)" : " (optional)"}`,
			...(field.description ? [plain(field.description)] : []),
			...fieldLimits(field));
		else if (request.fields.length) details.push("", ...request.fields.map((entry) =>
			`${plain(entry.label)}: ${Object.hasOwn(this.#answers, entry.name) ? plain(JSON.stringify(this.#answers[entry.name])) : "Skipped"}`));
		const editing = field && !choices.length;
		this.#panel.setContent({ title: theme.fg("accent", theme.bold(`MCP · ${plain(request.server_id)}`)),
			details: editing ? [] : details,
			...(editing ? { preview: { render: (width: number) => [
				...details.flatMap((line) => wrapTextWithAnsi(line, width)), "", ...this.#input.render(width),
			], invalidate: () => this.#input.invalidate() } } : {}),
			items: field && !choices.length ? [] : choices.map((choice) => ({ label: `${field?.type === "array" ? (this.#selectedValues.has(choice.value) ? "[x] " : "[ ] ") : ""}${plain(choice.label)}` })),
			selectedIndex: this.#selected, busy: this.#busy,
			status: this.#busy ? "Submitting…" : this.#error ? theme.fg("error", this.#error) : "",
			hints: [field ? "enter next" : "enter confirm", ...(field?.type === "array" ? ["space toggle"] : []),
				...(field && !field.required ? ["tab skip"] : []), ...(this.#fieldIndex ? ["shift+tab back"] : []), "esc cancel"],
		});
	}
}

function plain(value: string): string {
	return stripVTControlCharacters(value).replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, "");
}

function validateField(field: McpElicitationField, value: FormValue): string {
	if (typeof value === "number" && (!Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value)
		|| field.minimum !== undefined && value < field.minimum || field.maximum !== undefined && value > field.maximum)) return "Enter a number within the allowed range.";
	if (typeof value === "string" && ([...value].length < (field.minLength ?? 0) || [...value].length > Math.min(field.maxLength ?? 4_096, 4_096))) return "Check the text length.";
	if (Array.isArray(value) && (value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 64))) return "Check how many options are selected.";
	return "";
}

function fieldLimits(field: McpElicitationField): string[] {
	return [field.format, field.minimum === undefined ? undefined : `Minimum: ${field.minimum}`,
		field.maximum === undefined ? undefined : `Maximum: ${field.maximum}`,
		field.minLength === undefined ? undefined : `Minimum length: ${field.minLength}`,
		field.maxLength === undefined ? undefined : `Maximum length: ${field.maxLength}`]
		.filter((value): value is string => value !== undefined);
}
