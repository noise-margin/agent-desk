import { execFile, spawn } from "node:child_process";

export function execFileAsync(
  command: string,
  args: string[],
  options: { cwd?: string; timeout?: number; shell?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 15_000,
        windowsHide: true,
        encoding: "utf8",
        shell: options.shell,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new Error(
              `${command} ${args.join(" ")} failed: ${stderr || error.message}`,
              { cause: error },
            ),
          );
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

export async function detectCommand(
  command: string,
  versionArgs = ["--version"],
  options: { shell?: boolean } = {},
) {
  try {
    const { stdout, stderr } = await execFileAsync(command, versionArgs, {
      timeout: 8_000,
      shell: options.shell,
    });
    return { installed: true, version: (stdout || stderr).trim().split(/\r?\n/)[0] };
  } catch (error) {
    return {
      installed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { spawn };
