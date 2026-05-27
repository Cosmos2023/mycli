import React, { useEffect, useMemo, useReducer } from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { GatewayClient } from "./protocol/client.ts";
import { initialState, reduceShellState } from "./state/reducer.ts";
import { openTtyStreams } from "./terminal/tty.ts";

function RuntimeApp() {
  const [state, dispatch] = useReducer(reduceShellState, undefined, initialState);
  const client = useMemo(
    () =>
      new GatewayClient({
        input: process.stdin,
        output: process.stdout,
        log: (event) =>
          dispatch({ type: "gateway.event", method: event.method, params: event.params }),
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
      .then((payload) => dispatch({ type: "bootstrap.result", payload }));
    return () => client.stop();
  }, [client]);

  return (
    <App
      state={state}
      onSubmit={(message) => {
        dispatch({ type: "user.submit", message });
        void client.send("turn.submit", { message, client_turn_id: `ui_${Date.now()}` });
      }}
      onInterrupt={() => {
        void client.send("turn.interrupt", {});
      }}
      onDraftChange={() => undefined}
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
