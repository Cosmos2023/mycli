import fs from "node:fs";
import tty from "node:tty";

export type TtyStreams = {
  input: tty.ReadStream;
  output: tty.WriteStream;
  close: () => void;
};

export function openTtyStreams(): TtyStreams {
  const inputFd = fs.openSync("/dev/tty", "r");
  const outputFd = fs.openSync("/dev/tty", "w");
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
