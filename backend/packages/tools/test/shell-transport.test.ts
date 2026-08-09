import assert from "node:assert/strict";
import test from "node:test";
import type { ShellExit, ShellOutputChunk } from "../src/index.ts";
import { FakeShellTransportFactory } from "./support/fake-shell-transport.ts";

test("transport contract publishes output before exactly one exit", async () => {
	const factory = new FakeShellTransportFactory();
	const transport = await createFake(factory);
	const events: Array<ShellOutputChunk | ShellExit> = [];
	transport.onOutput((chunk) => events.push(chunk));
	transport.onExit((exit) => events.push(exit));

	transport.emitOutput({ sequence: 1, stream: "terminal", data: "ready" });
	transport.emitExit({ exitCode: 0, signal: null });
	transport.emitExit({ exitCode: 9, signal: null });

	assert.deepEqual(events, [
		{ sequence: 1, stream: "terminal", data: "ready" },
		{ exitCode: 0, signal: null },
	]);
});

test("transport contract supports input resize cleanup and idempotent close", async () => {
	const factory = new FakeShellTransportFactory();
	const transport = await createFake(factory);

	await transport.write("hello\n");
	await transport.resize(40, 120);
	assert.deepEqual(await transport.interrupt(), {
		state: "interrupted",
		signal: "SIGINT",
	});
	assert.deepEqual(await transport.terminate(), {
		state: "terminated",
		signal: "SIGTERM",
	});
	await transport.close();
	await transport.close();

	assert.deepEqual(transport.writes, ["hello\n"]);
	assert.deepEqual(transport.resizes, [{ rows: 40, columns: 120 }]);
	assert.equal(transport.interruptCalls, 1);
	assert.equal(transport.terminateCalls, 1);
	assert.equal(transport.closeCalls, 1);
});

async function createFake(factory: FakeShellTransportFactory) {
	return factory.create({
		executable: process.execPath,
		args: [],
		cwd: process.cwd(),
		env: {},
		platform: process.platform,
		tty: true,
		rows: 24,
		columns: 80,
	});
}
