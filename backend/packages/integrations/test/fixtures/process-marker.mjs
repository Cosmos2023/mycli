import { rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";

export async function writeProcessMarker(path) {
	await writeFile(path, String(process.pid), "utf8");
	const removeMarker = () => {
		try {
			rmSync(path, { force: true });
		} catch {
			// Test cleanup assertions report a marker that could not be removed.
		}
	};
	process.once("exit", removeMarker);
	for (const signal of ["SIGINT", "SIGTERM"]) {
		process.once(signal, () => {
			removeMarker();
			process.exit(0);
		});
	}
}
