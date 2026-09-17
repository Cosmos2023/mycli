import { skillReferencesInText, type SkillReference } from "@mycli/contracts";
import type { MycliUiQueuedInput } from "../interaction/ui-actions.ts";
import { expandEditorDraft, type EditorDraft, type EditorImageAttachment } from "../tui-core/components/editor.ts";

export interface ComposerDraft {
	readonly editor: EditorDraft;
	readonly localImages: readonly EditorImageAttachment[];
	readonly skillReferences: readonly SkillReference[];
}

/** Merge returned inputs before the current draft without interpreting literal paste markers. */
export function prependDraftInputs(draft: ComposerDraft, inputs: readonly (MycliUiQueuedInput | string)[]): ComposerDraft {
	const currentText = expandEditorDraft(draft.editor).trim();
	const parts: MycliUiQueuedInput[] = inputs.map((input) => typeof input === "string" ? { text: input } : input);
	if (currentText) parts.push({ text: currentText, localImages: [...draft.localImages], skillReferences: draft.skillReferences });
	let imageNumber = 1;
	const localImages: EditorImageAttachment[] = [];
	const text = parts.flatMap((part, partIndex) => {
		if (!part.text.trim()) return [];
		let content = part.text.trim();
		const replacements: Array<{ token: string; placeholder: string }> = [];
		for (const [imageIndex, image] of (part.localImages ?? []).entries()) {
			if (!content.includes(image.placeholder)) continue;
			const token = `\u0000mycli-image-${partIndex}-${imageIndex}\u0000`;
			const placeholder = `[image #${imageNumber++}]`;
			content = content.replaceAll(image.placeholder, token);
			replacements.push({ token, placeholder });
			localImages.push({ path: image.path, placeholder });
		}
		for (const replacement of replacements) content = content.replaceAll(replacement.token, replacement.placeholder);
		return [content];
	}).join("\n\n");
	const lines = text.split("\n");
	return {
		editor: { text, pastes: [], cursor: { line: lines.length - 1, col: lines.at(-1)!.length } },
		localImages,
		skillReferences: [...new Map(parts.flatMap((part) => skillReferencesInText(part.skillReferences ?? [], part.text))
			.map((skill) => [JSON.stringify([skill.id, skill.name, skill.revision]), skill])).values()],
	};
}
