import { normalizeCanonicalImages, type CanonicalImage } from "@mycli/core";
import type { McpContentItem, McpToolCallResult } from "./types.ts";

const RAW_TEXT_LIMIT = 12_000;
const RESULT_DISPLAY_LIMIT = 4_000;

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

/**
 * A rendering for the terminal, not the model: images and embedded resources become compact
 * markers instead of base64 or raw JSON, and text stays text.
 */
export function renderMcpDisplay(result: McpToolCallResult): string {
	const parts: string[] = [];
	for (const item of result.content) {
		if (item.type === "image") {
			parts.push(imageMarker(item.mimeType ?? item.mediaType));
		} else if (item.type === "audio") {
			parts.push("audio returned");
		} else if (item.type === "resource" && isRecord(item.resource)) {
			const resource = item.resource;
			const uri = typeof resource.uri === "string" ? resource.uri : undefined;
			const mimeType = typeof resource.mimeType === "string" ? resource.mimeType : undefined;
			parts.push(typeof resource.blob === "string" && mimeType?.startsWith("image/")
				? imageMarker(mimeType)
				: `resource · ${uri ?? mimeType ?? "embedded"}`);
		} else if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "json") {
			parts.push(jsonText(item.value ?? item.json ?? item.data));
		} else {
			parts.push(jsonText(contentMetadata(item)));
		}
	}
	if (result.structuredContent !== undefined) parts.push(jsonText(result.structuredContent));
	const text = parts.join("\n").trim();
	return text ? boundMcpText(text, RESULT_DISPLAY_LIMIT) : "";
}

function imageMarker(mimeType: unknown): string {
	return typeof mimeType === "string" && mimeType ? `image returned · ${mimeType}` : "image returned";
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
