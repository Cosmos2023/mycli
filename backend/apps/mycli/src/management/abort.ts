export function abortable<Value>(promise: Promise<Value>, signal: AbortSignal): Promise<Value> {
	return new Promise((resolve, reject) => {
		const onAbort = (): void => reject(abortError());
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

export function abortError(): Error {
	const error = new Error("interrupted");
	error.name = "AbortError";
	return error;
}
