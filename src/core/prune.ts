import fs from "node:fs";
import path from "node:path";
import { checkpointsDir } from "./paths.js";
import { readJson } from "./store.js";
import type { Checkpoint } from "./handoff.js";

export interface PrunableCheckpoint {
  checkpointId: string;
  status: Checkpoint["status"];
  jsonFile: string;
  markdownFile: string;
}

export interface PruneResult {
  taskId: string;
  kept: string[];
  deleted: PrunableCheckpoint[];
  dryRun: boolean;
}

function checkpointNumber(checkpointId: string): number {
  const match = /^cp-(\d+)$/.exec(checkpointId);
  return match ? Number(match[1]) : -1;
}

function storedCheckpoints(root: string, taskId: string): PrunableCheckpoint[] {
  const dir = checkpointsDir(root, taskId);
  if (!fs.existsSync(dir)) return [];

  return fs.readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const jsonFile = path.join(dir, file);
      const checkpoint = readJson<Checkpoint>(jsonFile);
      return {
        checkpointId: checkpoint.checkpointId,
        status: checkpoint.status,
        jsonFile,
        markdownFile: jsonFile.replace(/\.json$/, ".md"),
      };
    })
    .sort((a, b) => checkpointNumber(b.checkpointId) - checkpointNumber(a.checkpointId));
}

export function pruneTask(root: string, taskId: string, keep = 20, dryRun = false): PruneResult {
  if (!Number.isInteger(keep) || keep < 1) throw new Error("--keep must be a whole number greater than 0.");

  const checkpoints = storedCheckpoints(root, taskId);
  const retained = new Set(checkpoints.slice(0, keep).map((checkpoint) => checkpoint.checkpointId));
  const newestHandoff = checkpoints.find((checkpoint) => checkpoint.status === "handoff");
  if (newestHandoff) retained.add(newestHandoff.checkpointId);

  const deleted = checkpoints.filter((checkpoint) => !retained.has(checkpoint.checkpointId));
  if (!dryRun) {
    for (const checkpoint of deleted) {
      fs.rmSync(checkpoint.jsonFile, { force: true });
      fs.rmSync(checkpoint.markdownFile, { force: true });
    }
  }

  return {
    taskId,
    kept: checkpoints.filter((checkpoint) => retained.has(checkpoint.checkpointId)).map((checkpoint) => checkpoint.checkpointId),
    deleted,
    dryRun,
  };
}

export function pruneTasks(root: string, taskIds: string[], keep = 20, dryRun = false): PruneResult[] {
  return taskIds.map((taskId) => pruneTask(root, taskId, keep, dryRun));
}