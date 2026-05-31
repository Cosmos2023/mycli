import React, { useCallback, useEffect, useMemo, useReducer } from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { GatewayClient, GatewayRequestError } from "./protocol/client.ts";
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
  const reportRequestError = useCallback((method: string, error: unknown): void => {
    const gatewayError =
      error instanceof GatewayRequestError
        ? error
        : new GatewayRequestError({
            code: "request_failed",
            message: error instanceof Error ? error.message : "Request failed.",
            method,
          });
    dispatch({
      type: "request.failed",
      method: gatewayError.method || method,
      code: gatewayError.code,
      message: gatewayError.message,
    });
  }, []);
  const send = useCallback(
    (method: string, params: Record<string, unknown> = {}) =>
      client.send(method, params).catch((error: unknown) => {
        reportRequestError(method, error);
        throw error;
      }),
    [client, reportRequestError],
  );

  useEffect(() => {
    client.start();
    void send("session.bootstrap", {
      protocol_version: 1,
      client: { name: "mycli-node-tui", version: "0.2.0" },
    })
      .then(async (payload) => {
        dispatch({ type: "bootstrap.result", payload });
        const transcript = await send("transcript.load", {
          session_id: payload.session_id,
          limit: 200,
          before: null,
        });
        dispatch({ type: "transcript.loaded", payload: transcript });
      })
      .catch(() => undefined);
    return () => client.stop();
  }, [client, send]);

  return (
    <App
      state={state}
      onSubmit={(message) => {
        dispatch({ type: "user.submit", message });
        void send("turn.submit", { message, client_turn_id: `ui_${Date.now()}` }).catch(
          () => undefined,
        );
      }}
      onCommand={(command) => {
        void send("command.run", { command })
          .then((result) => {
            dispatch({ type: "command.result", command, result });
            if (result.exit_requested === true) {
              void send("shutdown", {}).then(() => process.exit(0), () => undefined);
            }
          })
          .catch(() => undefined);
      }}
      onInterrupt={() => {
        void send("turn.interrupt", {}).catch(() => undefined);
      }}
      onLocalAction={dispatch}
      onDraftChange={() => undefined}
      onDecision={(decisionId, choice) => {
        void send("approval.respond", { decision_id: decisionId, choice }).catch(() => undefined);
      }}
      onClarification={(requestId, response) => {
        void send("clarify.respond", { request_id: requestId, response }).catch(() => undefined);
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
