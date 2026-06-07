import fs from "node:fs";
import tty from "node:tty";

export type TtyStreams = {
  input: tty.ReadStream;
  output: tty.WriteStream;
  close: () => void;
};

export class TtyOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TtyOpenError";
  }
}

export function ttyOpenFailureMessage(error: unknown): string {
  const detail = error instanceof Error && error.message ? ` ${error.message}` : "";
  return [
    "Unable to open /dev/tty for the interactive TUI.",
    "Run mycli from an interactive terminal, or use the scripted/plain CLI path for non-TTY automation.",
    detail.trim() ? `Detail:${detail}` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function openTtyStreams(): TtyStreams {
  let inputFd: number;
  let outputFd: number;
  try {
    inputFd = fs.openSync("/dev/tty", "r");
    outputFd = fs.openSync("/dev/tty", "w");
  } catch (error) {
    throw new TtyOpenError(ttyOpenFailureMessage(error));
  }
  const input = new tty.ReadStream(inputFd);
  const output = new tty.WriteStream(outputFd);
  return {
    input,
    output,
    close: () => {
      input.destroy();
      output.end();
    },
  };
}
