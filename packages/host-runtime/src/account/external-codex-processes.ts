import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

export function parseProcessRows(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/u.exec(line);
    const command = match?.[3];
    if (match && command) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command });
  }
  return rows;
}

/** Codex executables outside the Host's own process tree. Names match case-sensitively so the
 * Desktop shell (`Codex`) is never mistaken for the CLI (`codex`). */
export function selectExternalCodexPids(
  rows: readonly ProcessRow[],
  input: { executableNames: readonly string[]; hostPid: number },
): number[] {
  const parents = new Map(rows.map((row) => [row.pid, row.ppid]));
  const names = new Set(input.executableNames);
  const ownedByHost = (pid: number): boolean => {
    for (let current = pid, hops = 0; current > 1 && hops < 64; hops++) {
      if (current === input.hostPid) return true;
      current = parents.get(current) ?? 0;
    }
    return false;
  };
  return rows
    .filter((row) => names.has(path.basename(row.command)) && !ownedByHost(row.pid))
    .map((row) => row.pid);
}

/** `CODEX_HOME` from a `ps eww` line; undefined when the environment is not visible. */
export function codexHomeFromEnvironmentListing(listing: string): string | undefined {
  return /(?:^|\s)CODEX_HOME=(\S+)/u.exec(listing)?.[1];
}

/**
 * Best-effort PIDs of Codex processes this Host does not own that share `home`.
 * Never terminates anything. Any detection failure yields [] and the switch relies on
 * post-install identity verification instead.
 */
export async function findExternalCodexProcesses(input: {
  home: string;
  defaultHome: string;
  executableNames: readonly string[];
  hostPid?: number;
}): Promise<number[]> {
  // ponytail: no process listing on Windows; add a tasklist/WMI reader if switching there needs it.
  if (process.platform === "win32") return [];
  try {
    const { stdout } = await run("ps", ["-axo", "pid=,ppid=,comm="], {
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const candidates = selectExternalCodexPids(parseProcessRows(stdout), {
      executableNames: input.executableNames,
      hostPid: input.hostPid ?? process.pid,
    });
    const sharing: number[] = [];
    for (const pid of candidates) {
      const listing = await run("ps", ["eww", "-o", "command=", "-p", String(pid)], {
        timeout: 3_000,
        maxBuffer: 1024 * 1024,
      }).then(
        (result) => result.stdout,
        () => "",
      );
      const home = codexHomeFromEnvironmentListing(listing);
      if (home === undefined ? input.home === input.defaultHome : path.resolve(home) === input.home)
        sharing.push(pid);
    }
    return sharing;
  } catch {
    return [];
  }
}
