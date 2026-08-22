import type {
	ApprovalPreviewDetails,
	FileMutationPreviewChange,
} from "@mycli/core";

export function approvalPreviewDetails(
	value: ApprovalPreviewDetails,
): ApprovalPreviewDetails {
	return {
		...(value.contentPreview !== undefined ? { contentPreview: value.contentPreview } : {}),
		...(value.contentLineCount !== undefined ? { contentLineCount: value.contentLineCount } : {}),
		...(value.contentChars !== undefined ? { contentChars: value.contentChars } : {}),
		...(value.contentTruncated !== undefined ? { contentTruncated: value.contentTruncated } : {}),
		...(value.diff !== undefined ? { diff: value.diff } : {}),
		...(value.diffChars !== undefined ? { diffChars: value.diffChars } : {}),
		...(value.diffTruncated !== undefined ? { diffTruncated: value.diffTruncated } : {}),
	};
}

export function approvalPreviewPayload(
	value: ApprovalPreviewDetails,
): Readonly<Record<string, string | number | boolean>> {
	return {
		...(value.contentPreview !== undefined ? { content_preview: value.contentPreview } : {}),
		...(value.contentLineCount !== undefined ? { content_line_count: value.contentLineCount } : {}),
		...(value.contentChars !== undefined ? { content_chars: value.contentChars } : {}),
		...(value.contentTruncated !== undefined ? { content_truncated: value.contentTruncated } : {}),
		...(value.diff !== undefined ? { diff: value.diff } : {}),
		...(value.diffChars !== undefined ? { diff_chars: value.diffChars } : {}),
		...(value.diffTruncated !== undefined ? { diff_truncated: value.diffTruncated } : {}),
	};
}

export function fileMutationChangesPayload(
	changes: readonly FileMutationPreviewChange[] | undefined,
): Readonly<Record<string, unknown>> {
	if (!changes || changes.length === 0) return {};
	return {
		file_changes: changes.slice(0, 64).map((change) => ({
			version: 1,
			kind: change.kind,
			path: change.path,
			...(change.previousPath ? { previous_path: change.previousPath } : {}),
			diff: change.diff,
			added_lines: change.addedLines,
			removed_lines: change.removedLines,
			truncated: change.truncated,
			omitted_chars: change.omittedChars,
		})),
	};
}
