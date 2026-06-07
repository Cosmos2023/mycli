import React, { useCallback, useEffect, useMemo, useReducer } from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { GatewayClient, GatewayRequestError } from "./protocol/client.ts";
import { initialState, reduceShellState } from "./state/reducer.ts";
import {
  runtimeCommandDispatch,
  sessionListOverlayLines,
  sessionResumeOverlayLines,
} from "./state/sessionCommands.ts";
import { openTtyStreams, TtyOpenError } from "./terminal/tty.ts";

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
      ...(error instanceof Error ? { detail: error.stack ?? error.message } : {}),
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
  const loadTranscript = useCallback(
    async (sessionId: unknown): Promise<void> => {
      const transcript = await send("transcript.load", {
        session_id: typeof sessionId === "string" && sessionId.trim() ? sessionId : undefined,
        limit: 200,
        before: null,
      });
      dispatch({ type: "transcript.loaded", payload: transcript });
    },
    [send],
  );

  useEffect(() => {
    client.start();
    void send("session.bootstrap", {
      protocol_version: 1,
      client: { name: "mycli-node-tui", version: "0.2.0" },
    })
      .then(async (payload) => {
        dispatch({ type: "bootstrap.result", payload });
        await loadTranscript(payload.session_id);
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
        const dispatchPlan = runtimeCommandDispatch(command);
        if (dispatchPlan.kind === "invalid") {
          dispatch({
            type: "command.result",
            command: dispatchPlan.command,
            result: { presentation: "overlay", lines: dispatchPlan.lines },
          });
          return;
        }
        if (dispatchPlan.kind === "session.list") {
          void send("session.list", {})
            .then((result) => {
              dispatch({
                type: "command.result",
                command,
                result: { presentation: "overlay", lines: sessionListOverlayLines(result) },
              });
            })
            .catch(() => undefined);
          return;
        }
        if (dispatchPlan.kind === "session.resume") {
          void send("session.resume", { session_id: dispatchPlan.sessionId })
            .then(async (result) => {
              dispatch({
                type: "command.result",
                command,
                result: { presentation: "overlay", lines: sessionResumeOverlayLines(result) },
              });
              await loadTranscript(result.session_id);
            })
            .catch(() => undefined);
          return;
        }
        void send("command.run", { command: dispatchPlan.command })
          .then((result) => {
            dispatch({ type: "command.result", command: dispatchPlan.command, result });
            if (result.exit_requested === true) {
              void send("shutdown", {}).then(() => process.exit(0), () => undefined);
            }
          })
          .catch(() => undefined);
      }}
      onInterrupt={() => {
        void send("turn.interrupt", {}).catch(() => undefined);
      }}
      onExit={() => {
        void send("shutdown", {}).then(() => process.exit(0), () => process.exit(0));
      }}
      onLocalAction={dispatch}
      onDraftChange={() => undefined}
      onDecision={(decisionId, choice) => {
        void send("approval.respond", { decision_id: decisionId, choice }).catch(() => undefined);
      }}
      onClarification={(requestId, response) => {
        void send("clarify.respond", { request_id: requestId, response }).catch(() => undefined);
      }}
      onTrustChoice={(choice) => {
        if (choice === "later") {
          dispatch({ type: "overlay.closed", message: "Workspace trust decision deferred." });
          return;
        }
        void send("workspace.trust.set", { state: choice }).catch(() => undefined);
      }}
    />
  );
}

let tty;
try {
  tty = openTtyStreams();
} catch (error) {
  const message =
    error instanceof TtyOpenError
      ? error.message
      : error instanceof Error
        ? error.message
        : "Unable to start the interactive TUI.";
  process.stderr.write(`[node-tui] ${message}\n`);
  process.exit(1);
}

const instance = render(<RuntimeApp />, {
  stdin: tty.input,
  stdout: tty.output,
  stderr: process.stderr,
});

process.on("exit", () => {
  instance.unmount();
  tty.close();
});
