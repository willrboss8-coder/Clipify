import path from "path";

/** Writable storage root (uploads, jobs, outputs). Override with STORAGE_ROOT on Render/Docker. */
export function getStorageRoot(): string {
  const raw = process.env.STORAGE_ROOT?.trim();
  if (raw) return path.resolve(raw);
  return path.resolve(process.cwd(), "storage");
}
