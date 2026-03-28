import { spawn, type ChildProcess } from "child_process";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import path from "path";
import { existsSync } from "fs";

const DAEMON_REL = path.join("scripts", "transcribe_daemon.py");

function pythonExecutable(): string {
  return process.env.PYTHON_PATH?.trim() || "python3";
}

/** When unset or non-"0", use persistent daemon if transcribe_daemon.py exists. */
export function isTranscribeDaemonEnabled(): boolean {
  const v = process.env.CLIP_TRANSCRIBE_DAEMON?.trim();
  if (v === "0") return false;
  return existsSync(path.resolve(process.cwd(), DAEMON_REL));
}

/** At least one of daemon or one-shot transcribe script is present (upload / worker preflight). */
export function hasTranscriptionScript(): boolean {
  const root = process.cwd();
  return (
    existsSync(path.resolve(root, DAEMON_REL)) ||
    existsSync(path.resolve(root, "scripts", "transcribe.py"))
  );
}

const READY_TIMEOUT_MS = 120_000;

let child: ChildProcess | null = null;
let rl: ReadlineInterface | null = null;
/** Resolved lines from stdout (one per logical message). */
const lineQueue: string[] = [];
const lineWaiters: Array<(line: string) => void> = [];
let ready = false;

function pushLine(line: string): void {
  if (lineWaiters.length > 0) {
    lineWaiters.shift()!(line);
  } else {
    lineQueue.push(line);
  }
}

function readLine(): Promise<string> {
  if (lineQueue.length > 0) {
    return Promise.resolve(lineQueue.shift()!);
  }
  return new Promise((resolve) => lineWaiters.push(resolve));
}

function resetDaemonState(): void {
  ready = false;
  rl?.close();
  rl = null;
  child = null;
  lineQueue.length = 0;
  lineWaiters.length = 0;
}

function attachChild(proc: ChildProcess): void {
  proc.stderr?.on("data", (d: Buffer) => {
    const s = d.toString();
    if (s.trim()) process.stderr.write(`[transcribe_daemon] ${s}`);
  });
  rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
  rl.on("line", (line) => pushLine(line));
  proc.on("exit", (code, signal) => {
    console.log(
      `[Transcribe daemon] process exited code=${code} signal=${signal ?? "none"}`
    );
    for (const w of lineWaiters) {
      w("");
    }
    lineWaiters.length = 0;
    resetDaemonState();
  });
  proc.on("error", (err) => {
    console.error("[Transcribe daemon] spawn error:", err);
  });
}

async function ensureDaemonReady(): Promise<void> {
  if (ready && child && child.exitCode === null) return;

  const scriptPath = path.resolve(process.cwd(), DAEMON_REL);
  const proc = spawn(pythonExecutable(), [scriptPath], {
    stdio: ["pipe", "pipe", "pipe"],
    env: process.env,
  });
  child = proc;
  attachChild(proc);

  let first: string;
  try {
    first = await Promise.race([
      readLine(),
      new Promise<string>((_, reject) =>
        setTimeout(
          () => reject(new Error("Transcribe daemon ready timeout")),
          READY_TIMEOUT_MS
        )
      ),
    ]);
  } catch (err) {
    proc.kill("SIGTERM");
    resetDaemonState();
    throw err;
  }

  if (!first) {
    proc.kill("SIGTERM");
    resetDaemonState();
    throw new Error("Transcribe daemon exited before ready.");
  }

  let msg: { type?: string; model_load_sec?: number };
  try {
    msg = JSON.parse(first) as { type?: string; model_load_sec?: number };
  } catch {
    proc.kill("SIGTERM");
    resetDaemonState();
    throw new Error(`Transcribe daemon invalid ready line: ${first.slice(0, 200)}`);
  }
  if (msg.type !== "ready") {
    proc.kill("SIGTERM");
    resetDaemonState();
    throw new Error(`Transcribe daemon expected ready, got: ${first.slice(0, 200)}`);
  }
  console.log(
    `[Transcribe daemon] ready model_load_sec=${msg.model_load_sec ?? "?"}`
  );
  ready = true;
}

/** Serialize jobs: one in-flight request to the daemon at a time. */
let chain: Promise<unknown> = Promise.resolve();

export interface PersistentTranscribeResult {
  transcribeWallSec?: number;
}

export function runPersistentTranscribe(
  audioPath: string,
  outputJsonPath: string
): Promise<PersistentTranscribeResult> {
  const task = chain.then(() => doTranscribe(audioPath, outputJsonPath));
  chain = task.catch(() => undefined);
  return task;
}

async function doTranscribe(
  audioPath: string,
  outputJsonPath: string
): Promise<PersistentTranscribeResult> {
  await ensureDaemonReady();
  if (!child?.stdin) {
    throw new Error("Transcribe daemon has no stdin.");
  }

  const payload = JSON.stringify({
    audio_path: audioPath,
    output_json_path: outputJsonPath,
  });
  child.stdin.write(`${payload}\n`);

  const line = await readLine();
  if (!line) {
    throw new Error("Transcribe daemon closed before response.");
  }

  let parsed: {
    ok?: boolean;
    error?: string;
    transcribe_wall_sec?: number;
  };
  try {
    parsed = JSON.parse(line) as typeof parsed;
  } catch {
    throw new Error(`Transcribe daemon invalid response: ${line.slice(0, 200)}`);
  }

  if (!parsed.ok) {
    throw new Error(
      parsed.error ?? "Transcribe daemon reported failure with no error message."
    );
  }

  const transcribeWallSec = parsed.transcribe_wall_sec;
  if (typeof transcribeWallSec === "number") {
    console.log(
      `[Transcribe daemon] transcribe_wall_sec=${transcribeWallSec.toFixed(3)}`
    );
  }

  return { transcribeWallSec };
}
