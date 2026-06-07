import assert from "node:assert/strict";
import test from "node:test";
import { initialState, reduceShellState } from "../src/state/reducer.ts";
import { handleLocalCommand, isLocalCommand } from "../src/state/localCommands.ts";
import {
  SLASH_COMMAND_CATALOG,
  slashCommandCompletions,
  slashCommandSuggestions,
} from "../src/state/slashCatalog.ts";

test("recognizes only Node-local slash commands", () => {
  assert.equal(isLocalCommand("/help"), true);
  assert.equal(isLocalCommand("/?"), true);
  assert.equal(isLocalCommand("/help anything"), true);
  assert.equal(isLocalCommand("/theme"), true);
  assert.equal(isLocalCommand("/theme mono"), true);
  assert.equal(isLocalCommand("/clear"), true);
  assert.equal(isLocalCommand("/history"), true);
  assert.equal(isLocalCommand("/search mycli"), true);
  assert.equal(isLocalCommand("/export"), true);
  assert.equal(isLocalCommand("/copy"), true);
  assert.equal(isLocalCommand("/view"), false);
  assert.equal(isLocalCommand("/usage"), false);
  assert.equal(isLocalCommand("/sessions"), false);
});

test("help command opens local overlay with key actions", () => {
  const state = initialState({ rawThemeName: "deep-teal" });
  const action = handleLocalCommand("/help", state);
  const next = reduceShellState(state, action);

  assert.equal(action.type, "command.result");
  assert.equal(next.overlay.visible, true);
  assert.equal(next.overlay.title, "/help");
  assert.match(next.overlay.lines.join("\n"), /Enter send message/);
  assert.match(next.overlay.lines.join("\n"), /Approval: press 1-9/);
  assert.match(next.overlay.lines.join("\n"), /\/theme\s+local\s+mutating\s+local/);
  assert.match(next.overlay.lines.join("\n"), /\/compact\s+runtime\s+mutating\s+runtime/);
  assert.match(next.overlay.lines.join("\n"), /\/trust\s+safety\s+mutating\s+runtime/);
  assert.equal(next.transcript.length, 0);
});

test("slash command catalog registers P1.1 and P1.3 commands with routing metadata", () => {
  const commands = new Map(SLASH_COMMAND_CATALOG.map((command) => [command.name, command]));

  for (const name of [
    "/help",
    "/?",
    "/changes",
    "/diff",
    "/undo",
    "/checkpoint",
    "/history",
    "/search",
    "/export",
    "/copy",
    "/model",
    "/compact",
    "/retry",
    "/queue",
    "/title",
    "/statusbar",
    "/redraw",
    "/terminal-setup",
    "/details",
    "/trust",
  ]) {
    assert.ok(commands.has(name), `${name} should be registered`);
  }
  assert.equal(commands.get("/help")?.route.kind, "local");
  assert.equal(commands.get("/changes")?.route.kind, "runtime");
  assert.equal(commands.get("/diff")?.route.kind, "reserved");
  assert.equal(commands.get("/undo")?.mutating, true);
  assert.equal(commands.get("/checkpoint")?.route.kind, "reserved");
  assert.equal(commands.get("/history")?.route.kind, "local");
  assert.equal(commands.get("/search")?.route.kind, "local");
  assert.equal(commands.get("/export")?.route.kind, "local");
  assert.equal(commands.get("/copy")?.route.kind, "local");
  assert.equal(commands.get("/compact")?.route.kind, "reserved");
  assert.equal(commands.get("/redraw")?.route.kind, "reserved");
  assert.equal(commands.get("/terminal-setup")?.route.kind, "reserved");
  assert.equal(commands.get("/queue")?.mutating, false);
  assert.equal(commands.get("/trust")?.category, "safety");
});

test("slash command catalog filters completions and suggests unknown commands", () => {
  assert.deepEqual(
    slashCommandCompletions("/sta").map((command) => command.name),
    ["/status", "/statusbar"],
  );
  assert.deepEqual(
    slashCommandCompletions("/trst").map((command) => command.name),
    [],
  );
  assert.deepEqual(
    slashCommandSuggestions("/trst").map((command) => command.name),
    ["/trust"],
  );
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

test("history search export and copy commands open bounded local overlays", () => {
  const state = {
    ...initialState({ rawThemeName: "deep-teal" }),
    transcript: [
      { id: "u1", type: "user" as const, text: "Read pyproject", folded: false, metadata: {} },
      {
        id: "a1",
        type: "assistant_final" as const,
        text: "Project is mycli.\nUse pytest for tests.",
        folded: false,
        metadata: {},
      },
    ],
  };

  const history = reduceShellState(state, handleLocalCommand("/history", state));
  assert.equal(history.overlay.visible, true);
  assert.equal(history.overlay.presentationHint, "history");
  assert.match(history.overlay.lines.join("\n"), /user: Read pyproject/);

  const search = reduceShellState(state, handleLocalCommand("/search pytest", state));
  assert.equal(search.overlay.presentationHint, "transcript search");
  assert.match(search.overlay.lines.join("\n"), /matches for "pytest"/);

  const exported = reduceShellState(state, handleLocalCommand("/export", state));
  assert.equal(exported.overlay.presentationHint, "transcript export preview");
  assert.match(exported.overlay.lines.join("\n"), /Preview only\. No file was written/);

  const copy = reduceShellState(state, handleLocalCommand("/copy", state));
  assert.equal(copy.overlay.presentationHint, "manual copy");
  assert.match(copy.overlay.lines.join("\n"), /Latest assistant message/);
  assert.match(copy.overlay.lines.join("\n"), /Project is mycli/);
});
