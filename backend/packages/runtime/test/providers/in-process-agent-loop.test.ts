import assert from "node:assert/strict";
import test from "node:test";
import {
	parseAgentExecutionAdapter,
	resolveAgentExecutionAdapters,
} from "../../src/index.ts";

test("agent execution adapter defaults to Worker and rejects unknown values", () => {
	assert.equal(parseAgentExecutionAdapter(undefined), "worker");
	assert.equal(parseAgentExecutionAdapter(""), "worker");
	assert.equal(parseAgentExecutionAdapter("in_process"), "in_process");
	assert.equal(parseAgentExecutionAdapter("worker"), "worker");
	assert.throws(() => parseAgentExecutionAdapter("automatic"), TypeError);
});

test("agent execution adapters support independent root and subagent overrides", () => {
	assert.deepEqual(resolveAgentExecutionAdapters({}), {
		root: "worker",
		subagent: "worker",
	});
	assert.deepEqual(resolveAgentExecutionAdapters({
		MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
	}), {
		root: "worker",
		subagent: "worker",
	});
	assert.deepEqual(resolveAgentExecutionAdapters({
		MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		MYCLI_ROOT_AGENT_EXECUTION_ADAPTER: "in_process",
	}), {
		root: "in_process",
		subagent: "worker",
	});
	assert.deepEqual(resolveAgentExecutionAdapters({
		MYCLI_AGENT_EXECUTION_ADAPTER: "worker",
		MYCLI_SUBAGENT_EXECUTION_ADAPTER: "in_process",
	}), {
		root: "worker",
		subagent: "in_process",
	});
	assert.deepEqual(resolveAgentExecutionAdapters({
		MYCLI_ROOT_AGENT_EXECUTION_ADAPTER: "worker",
		MYCLI_SUBAGENT_EXECUTION_ADAPTER: "",
	}), {
		root: "worker",
		subagent: "worker",
	});
});

test("agent execution adapter overrides reject invalid values without exposing them", () => {
	assert.throws(
		() => resolveAgentExecutionAdapters({ MYCLI_AGENT_EXECUTION_ADAPTER: "automatic" }),
		/MYCLI_AGENT_EXECUTION_ADAPTER/u,
	);
	assert.throws(
		() => resolveAgentExecutionAdapters({ MYCLI_ROOT_AGENT_EXECUTION_ADAPTER: "automatic" }),
		/MYCLI_ROOT_AGENT_EXECUTION_ADAPTER/u,
	);
	assert.throws(
		() => resolveAgentExecutionAdapters({ MYCLI_SUBAGENT_EXECUTION_ADAPTER: "automatic" }),
		/MYCLI_SUBAGENT_EXECUTION_ADAPTER/u,
	);
});
