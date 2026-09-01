import assert from "node:assert/strict";
import test from "node:test";
import {
	ConnectivityStepComponent,
	ReadyStepComponent,
	WelcomeStepComponent,
} from "../src/components/startup-onboarding.ts";
import {
	StartupOnboardingCoordinator,
	startupOnboardingStages,
} from "../src/startup-onboarding.ts";
import { visibleWidth } from "../src/tui-core/index.ts";

function stripAnsi(text: string): string {
	return text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))/g, "");
}

test("startup onboarding queues only stages required by authoritative readiness", () => {
	assert.deepEqual(startupOnboardingStages({
		authenticationRequired: false,
		trustRequired: false,
		modelSelectionAvailable: true,
	}), []);
	assert.deepEqual(startupOnboardingStages({
		authenticationRequired: false,
		trustRequired: true,
		modelSelectionAvailable: true,
	}), ["trust"]);
	assert.deepEqual(startupOnboardingStages({
		authenticationRequired: true,
		trustRequired: true,
		modelSelectionAvailable: true,
	}), ["welcome", "credential", "model", "connectivity", "trust", "permission", "ready"]);
	assert.deepEqual(startupOnboardingStages({
		authenticationRequired: true,
		trustRequired: false,
		modelSelectionAvailable: false,
	}), ["welcome", "credential", "connectivity", "permission", "ready"]);
});

test("startup onboarding coordinator rejects out-of-order completion", () => {
	const coordinator = new StartupOnboardingCoordinator({
		authenticationRequired: true,
		trustRequired: true,
		modelSelectionAvailable: false,
	});
	assert.equal(coordinator.current(), "welcome");
	assert.throws(() => coordinator.advance("credential"), /startup_onboarding_stage_mismatch/);
	assert.equal(coordinator.advance("welcome"), "credential");
});

test("connectivity defaults to skip and keeps failed validation retryable", () => {
	const actions: string[] = [];
	const skipped = new ConnectivityStepComponent({
		validationAvailable: true,
		onSkip: () => actions.push("skip"),
		onValidate: () => actions.push("validate"),
		onCancel: () => actions.push("cancel"),
	});
	assert.match(stripAnsi(skipped.render(80).join("\n")), /› Skip for now/);
	skipped.handleInput("\r");
	assert.deepEqual(actions, ["skip"]);

	const validated = new ConnectivityStepComponent({
		validationAvailable: true,
		onSkip: () => actions.push("skip"),
		onValidate: () => actions.push("validate"),
		onCancel: () => actions.push("cancel"),
	});
	validated.handleInput("\x1b[B");
	validated.handleInput("\r");
	assert.deepEqual(actions, ["skip", "validate"]);
	validated.setError("Provider rejected the credential.");
	assert.match(stripAnsi(validated.render(80).join("\n")), /Provider rejected the credential/);
	validated.handleInput("\r");
	validated.handleInput("\x1b");
	assert.deepEqual(actions, ["skip", "validate", "validate", "cancel"]);
});

test("startup framing steps are keyboard complete and width safe", () => {
	const actions: string[] = [];
	const welcome = new WelcomeStepComponent({
		onContinue: () => actions.push("welcome"),
		onCancel: () => actions.push("welcome-cancel"),
	});
	const ready = new ReadyStepComponent({
		provider: "openai",
		model: "gpt-5.4",
		permission: "Ask for approval",
		trusted: true,
		onContinue: () => actions.push("ready"),
		onCancel: () => actions.push("ready-cancel"),
	});
	welcome.handleInput("\r");
	welcome.handleInput("\x1b");
	ready.handleInput("\r");
	ready.handleInput("\x1b");
	assert.deepEqual(actions, ["welcome", "welcome-cancel", "ready", "ready-cancel"]);

	for (const component of [welcome, ready]) {
		for (const width of [28, 48, 80]) {
			for (const line of component.render(width)) {
				assert.ok(visibleWidth(line) <= width, `${width}: ${stripAnsi(line)}`);
			}
		}
	}
});
