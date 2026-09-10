import { Container } from "../../tui-core/tui.ts";

export class FrameCachedContainer extends Container {
	private cachedFrameId: number | null = null;
	private cachedWidth: number | null = null;
	private cachedRevision: number | undefined;
	private cachedLines: string[] = [];

	constructor(
		private readonly activeFrameId: () => number | null,
		private readonly cacheAcrossFrames = false,
	) {
		super();
	}

	override render(width: number): string[] {
		const frameId = this.activeFrameId();
		const revision = this.getRenderCacheKey();
		const canReuse =
			revision !== undefined &&
			revision === this.cachedRevision &&
			width === this.cachedWidth &&
			(this.cacheAcrossFrames || (frameId !== null && frameId === this.cachedFrameId));
		if (canReuse) {
			return this.cachedLines;
		}
		const lines = super.render(width);
		if (revision !== undefined && (this.cacheAcrossFrames || frameId !== null)) {
			this.cachedFrameId = frameId;
			this.cachedWidth = width;
			this.cachedRevision = revision;
			this.cachedLines = lines;
		}
		return lines;
	}
}
