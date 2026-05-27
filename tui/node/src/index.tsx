import React from "react";
import { render } from "ink";
import { App } from "./app/App.tsx";
import { initialState } from "./state/reducer.ts";
import { openTtyStreams } from "./terminal/tty.ts";

const tty = openTtyStreams();
const instance = render(<App state={initialState()} />, {
  stdin: tty.input,
  stdout: tty.output,
  stderr: process.stderr,
});

process.on("exit", () => {
  instance.unmount();
  tty.close();
});
