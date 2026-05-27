import assert from "node:assert/strict";
import test from "node:test";
import { initialState, reduceShellState } from "../src/state/reducer.ts";
import { handleLocalCommand, isLocalCommand } from "../src/state/localCommands.ts";

test("recognizes only Node-local slash commands", () => {
  assert.equal(isLocalCommand("/theme"), true);
  assert.equal(isLocalCommand("/theme mono"), true);
  assert.equal(isLocalCommand("/clear"), true);
  assert.equal(isLocalCommand("/usage"), false);
  assert.equal(isLocalCommand("/sessions"), false);
});

test("theme command changes reducer theme without gateway command.run", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const action = handleLocalCommand("/theme mono", state);

  assert.equal(action.type, "theme.changed");
  const next = reduceShellState(state, action);
  assert.equal(next.themeName, "mono");
  assert.equal(next.themeNotice, "Theme changed to mono.");
  assert.equal(next.transcript.at(-1)?.type, "command_output");
});

test("bare theme command lists available themes and current theme", () => {
  const state = initialState({ rawThemeName: "graphite" });
  const action = handleLocalCommand("/theme", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "local.command_output");
  assert.match(next.transcript.at(-1)?.text ?? "", /current=graphite/);
  assert.match(next.transcript.at(-1)?.text ?? "", /deep-teal, graphite, mono, amber/);
});

test("invalid theme command keeps current theme and records failure", () => {
  const state = initialState({ rawThemeName: "amber" });
  const action = handleLocalCommand("/theme missing", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "theme.failed");
  assert.equal(next.themeName, "amber");
  assert.equal(next.transcript.at(-1)?.text, "Unknown theme: missing. Keeping amber.");
});

test("clear command clears visible transcript only", () => {
  let state = initialState({ rawThemeName: "deep-teal" });
  state = reduceShellState(state, { type: "user.submit", message: "hello" });
  const action = handleLocalCommand("/clear", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "transcript.cleared");
  assert.equal(next.transcript.length, 1);
  assert.equal(next.transcript[0]?.type, "system_notice");
  assert.match(next.transcript[0]?.text ?? "", /Visible transcript cleared/);
});
