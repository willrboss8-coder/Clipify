import { readFile } from "fs/promises";
import { spawn } from "child_process";
import { extractAudio } from "@/lib/ffmpeg";
import type { Transcript } from "@/lib/segmenter";
import { persistPipelineStage } from "@/lib/stages/persist";
import {
  isTranscribeDaemonEnabled,
  runPersistentTranscribe,
} from "@/lib/persistent-transcribe";

function pythonExecutable(): string {
  return process.env.PYTHON_PATH?.trim() || "python3";
}

function runPython(
  scriptPath: string,
  args: string[]
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(pythonExecutable(), [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`python3 exited ${code}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
    proc.on("error", reject);
  });
}

export interface ExtractTranscribeStageResult {
  transcript: Transcript;
  extractSec: number;
  transcribeSec: number;
}

export async function runExtractAndTranscribeStage(params: {
  jobId: string;
  scriptPath: string;
  videoPath: string;
  audioPath: string;
  transcriptPath: string;
  extractOpts?: { maxDurationSec: number };
  claimedAtMs: number;
}): Promise<{
  result: ExtractTranscribeStageResult;
  claimToProcessingStartSec: number;
}> {
  const {
    jobId,
    scriptPath,
    videoPath,
    audioPath,
    transcriptPath,
    extractOpts,
    claimedAtMs,
  } = params;

  const claimToProcessingStartSec = (Date.now() - claimedAtMs) / 1000;

  let extractSec: number;
  {
    const t0 = performance.now();
    await extractAudio(videoPath, audioPath, extractOpts);
    extractSec = (performance.now() - t0) / 1000;
  }

  let transcript: Transcript;
  let transcribeSec: number;
  {
    const t0 = performance.now();
    if (isTranscribeDaemonEnabled()) {
      await runPersistentTranscribe(audioPath, transcriptPath);
    } else {
      await runPython(scriptPath, [audioPath, transcriptPath]);
    }

    const transcriptRaw = await readFile(transcriptPath, "utf-8");
    try {
      transcript = JSON.parse(transcriptRaw) as Transcript;
    } catch {
      throw new Error("Transcription produced invalid JSON.");
    }
    transcribeSec = (performance.now() - t0) / 1000;
  }

  await persistPipelineStage(jobId, "transcribed");

  return {
    result: { transcript, extractSec, transcribeSec },
    claimToProcessingStartSec,
  };
}
