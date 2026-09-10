export async function settlementWithin(
	operation: Promise<unknown>,
	timeoutMs: number,
): Promise<"fulfilled" | "rejected" | "timeout"> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation.then(
				() => "fulfilled" as const,
				() => "rejected" as const,
			),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
