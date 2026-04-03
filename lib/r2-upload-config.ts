/** Use single presigned PUT below this size (bytes). */
export const R2_MULTIPART_THRESHOLD_BYTES = 16 * 1024 * 1024;

/**
 * Part size for multipart upload. S3/R2 require ≥5 MiB per part except the last.
 * 8 MiB balances request count vs reliability.
 */
export const R2_MULTIPART_CHUNK_BYTES = 8 * 1024 * 1024;

export const R2_MULTIPART_PART_MAX_RETRIES = 3;
