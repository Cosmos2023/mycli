import React, { useEffect, useMemo, useReducer } from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { GatewayClient } from "./protocol/client.ts";
import { initialState, reduceShellState } from "./state/reducer.ts";
import { openTtyStreams } from "./terminal/tty.ts";

function RuntimeApp() {
  const themeInit =
    process.env.MYCLI_TUI_THEME === undefined
      ? {}
      : { rawThemeName: process.env.MYCLI_TUI_THEME };
  const [state, dispatch] = useReducer(
    reduceShellState,
    themeInit,
    initialState,
  );
  const client = useMemo(
    () =>
      new GatewayClient({
        input: process.stdin,
        output: process.stdout,
        log: (event) => {
          if (event.method === "runtime.event") {
            return;
          }
          dispatch({ type: "gateway.event", method: event.method, params: event.params });
        },
      }),
    [],
  );

  useEffect(() => {
    client.start();
    void client
      .send("session.bootstrap", {
        protocol_version: 1,
        client: { name: "mycli-node-tui", version: "0.2.0" },
      })
      .then(async (payload) => {
        dispatch({ type: "bootstrap.result", payload });
        const transcript = await client.send("transcript.load", {
          session_id: payload.session_id,
          limit: 200,
          before: null,
        });
        dispatch({ type: "transcript.loaded", payload: transcript });
      });
    return () => client.stop();
  }, [client]);

  return (
    <App
      state={state}
      onSubmit={(message) => {
        dispatch({ type: "user.submit", message });
        void client.send("turn.submit", { message, client_turn_id: `ui_${Date.now()}` });
      }}
      onCommand={(command) => {
        void client.send("command.run", { command }).then((result) => {
          dispatch({ type: "command.result", command, result });
          if (result.exit_requested === true) {
            void client.send("shutdown", {}).then(() => process.exit(0));
          }
        });
      }}
      onInterrupt={() => {
        void client.send("turn.interrupt", {});
      }}
      onLocalAction={dispatch}
      onDraftChange={() => undefined}
      onDecision={(decisionId, choice) => {
        void client.send("approval.respond", { decision_id: decisionId, choice });
      }}
    />
  );
}

const tty = openTtyStreams();
const instance = render(<RuntimeApp />, {
  stdin: tty.input,
  stdout: tty.output,
  stderr: process.stderr,
});

process.on("exit", () => {
  instance.unmount();
  tty.close();
});
