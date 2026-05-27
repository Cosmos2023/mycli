import("./smoke/scriptedClient.ts")
  .then(({ runScriptedClient }) => runScriptedClient())
  .catch((error) => {
    process.stderr.write(`[node-tui] error: ${error.message}\n`);
    process.exitCode = 1;
  });
