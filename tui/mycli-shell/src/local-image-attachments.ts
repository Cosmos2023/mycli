const LOCAL_IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const;
const LOCAL_IMAGE_FILE_RE = new RegExp(`\\.(${LOCAL_IMAGE_EXTENSIONS.join("|")})$`, "i");

export function isLocalImageAttachmentPath(path: string): boolean {
	return LOCAL_IMAGE_FILE_RE.test(path);
}

