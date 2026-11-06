import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { envelopeSchema } from "../../src/shared/commands.js";

/** Real installed CLI boundary; secrets travel over stdin, never argv. */
export async function daemonCli(
  directory: string,
  action: string,
  body?: unknown,
  env?: NodeJS.ProcessEnv,
  launch?: { executable: string; script: string },
) {
  const request = action === "command" ? envelopeSchema.safeParse(body) : null;
  const operation = request?.success
    ? `${action} ${request.data.command.type} [${request.data.id}]`
    : action;
  const started = performance.now();
  const input = body === undefined ? "" : JSON.stringify(body);
  const child = spawn(
    launch?.executable ?? process.execPath,
    [
      launch?.script ?? resolve("node_modules/@aster/cli/dist/cli/main.js"),
      "--data-dir",
      directory,
      action,
    ],
    {
      windowsHide: true,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const output: Buffer[] = [],
    errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  let inputError: Error | undefined;
  child.stdin.on("error", (error: Error) => {
    inputError = error;
  });
  child.stdin.end(input);
  return await new Promise<unknown>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== 0)
        reject(
          new Error(
            `${operation}: exit ${code ?? signal}, ${Math.round(performance.now() - started)} ms: ${Buffer.concat(errors).toString("utf8")}`,
          ),
        );
      else {
        if (inputError) {
          reject(
            new Error(`${operation}: CLI input channel failed`, {
              cause: inputError,
            }),
          );
          return;
        }
        try {
          resolvePromise(JSON.parse(Buffer.concat(output).toString("utf8")));
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}
