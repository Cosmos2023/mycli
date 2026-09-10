import { normalizeCanonicalImages, type CanonicalImage } from "@mycli/core";
import type { McpContentItem, McpToolCallResult } from "./types.ts";

const RAW_TEXT_LIMIT = 12_000;

interface RenderedMcpContent {
	readonly text: string;
	readonly images: readonly CanonicalImage[];
	readonly rawTruncated: boolean;
	readonly invalidImages: boolean;
}

export function renderMcpContent(result: McpToolCallResult): RenderedMcpContent {
	const parts: string[] = [];
	const imageValues: unknown[] = [];
	let rawTruncated = false;
	for (const item of result.content) {
		let raw: string;
		if (item.type === "image") {
			imageValues.push({ mediaType: item.mimeType ?? item.mediaType, data: item.data });
			raw = `[MCP image ${imageValues.length}]`;
		} else if (item.type === "resource" && isRecord(item.resource)) {
			const resource = item.resource;
			if (typeof resource.blob === "string" && typeof resource.mimeType === "string"
				&& resource.mimeType.startsWith("image/")) {
				imageValues.push({ mediaType: resource.mimeType, data: resource.blob });
			}
			raw = jsonText(contentMetadata(item));
		} else if (item.type === "text" && typeof item.text === "string") {
			raw = item.text;
		} else if (item.type === "json") {
			raw = jsonText(item.value ?? item.json ?? item.data);
		} else {
			raw = jsonText(contentMetadata(item));
		}
		const text = boundMcpText(raw, RAW_TEXT_LIMIT);
		parts.push(text);
		rawTruncated ||= text !== raw;
	}
	if (result.structuredContent !== undefined) {
		const raw = jsonText(result.structuredContent);
		const text = boundMcpText(raw, RAW_TEXT_LIMIT);
		parts.push(text);
		rawTruncated ||= text !== raw;
	}
	let images: readonly CanonicalImage[] = [];
	let invalidImages = false;
	try {
		images = normalizeCanonicalImages(imageValues);
	} catch {
		invalidImages = true;
		parts.unshift("MCP images unavailable: invalid or oversized image data.");
	}
	return { text: parts.join("\n"), images, rawTruncated, invalidImages };
}

export function contentMetadata(item: McpContentItem): Readonly<Record<string, unknown>> {
	if (item.type === "image" || item.type === "audio") {
		return { type: item.type, mimeType: item.mimeType ?? item.mediaType, dataOmitted: true };
	}
	if (item.type === "resource" && isRecord(item.resource)) {
		const { blob, ...resource } = item.resource;
		return { type: item.type, resource: { ...resource, ...(blob === undefined ? {} : { blobOmitted: true }) } };
	}
	return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, value]) => [
		key, typeof value === "string" ? boundMcpText(value, RAW_TEXT_LIMIT) : value,
	])));
}

export function jsonText(value: unknown): string {
	try { return JSON.stringify(value) ?? "null"; } catch { return "[unserializable MCP content]"; }
}

export function boundMcpText(value: string, limit: number): string {
	if (value.length <= limit) return value;
	const suffix = "... [truncated]";
	return `${value.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
