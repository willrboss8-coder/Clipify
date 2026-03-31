# Cloudflare R2 presigned upload (testing)

This project can issue **presigned PUT** URLs so browsers upload video **directly to R2** instead of through Next.js.

## Environment variables

Set these where the Next.js app runs:

| Variable | Description |
|----------|-------------|
| `R2_ACCOUNT_ID` | Cloudflare account ID (R2 overview in dashboard) |
| `R2_BUCKET` | Bucket name |
| `R2_ACCESS_KEY_ID` | R2 API token access key |
| `R2_SECRET_ACCESS_KEY` | R2 API token secret |

Create an **R2 API token** with **Object Read & Write** on the target bucket (or broader for dev).

## CORS (required for browser PUT)

In the Cloudflare dashboard: **R2 → your bucket → Settings → CORS policy**. Example:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3000", "https://your-production-domain.com"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["Content-Type"],
    "ExposeHeaders": ["ETag", "Content-Length"],
    "MaxAgeSeconds": 3600
  }
]
```

Adjust `AllowedOrigins` to your app URL(s).

## Test flow with curl

### 1. Create a job (init)

Requires a valid Clerk session cookie (`__session` or your app’s auth). Example:

```bash
curl -sS -X POST "http://localhost:3000/api/process/init" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d '{"platform":"tiktok","goal":"growth"}'
```

Save `jobId` from the JSON response.

### 2. Request a presigned URL

```bash
export JOB_ID="<job-uuid-from-init>"

curl -sS -X POST "http://localhost:3000/api/process/upload-url" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d "{\"jobId\":\"$JOB_ID\"}"
```

Response includes `uploadUrl`, `key`, `bucket`, `expiresIn`, `contentType`.

### 3. PUT a file to R2

Use the exact `uploadUrl` from step 2 (quoted; it contains query parameters):

```bash
export UPLOAD_URL='<paste uploadUrl here>'

curl -sS -X PUT "$UPLOAD_URL" \
  -H "Content-Type: video/mp4" \
  --data-binary "@./sample.mp4"
```

A successful upload returns **200** with an `ETag` header from R2.

### 4. Complete the job (R2 → disk + queue)

After the object exists in R2, call **upload-complete** (no file body; server copies from R2 to `STORAGE_ROOT/uploads/<jobId>.mp4`):

```bash
curl -sS -X POST "http://localhost:3000/api/process/upload-complete" \
  -H "Content-Type: application/json" \
  -H "Cookie: <your-session-cookie>" \
  -d "{\"jobId\":\"$JOB_ID\"}"
```

Expect **202** with `{ "jobId", "status": "queued", "message": ... }` — same shape as **POST /api/process/upload**.

**Alternative (no R2):** you can still use multipart **POST /api/process/upload** with `jobId` + `file` instead of steps 2–4; do not use both paths for the same job.

## Troubleshooting

- **503** from `/api/process/upload-url` or **upload-complete**: R2 env vars missing or wrong.
- **403** on PUT to R2: CORS, wrong `Content-Type`, or expired presigned URL.
- **409** from upload-url / upload-complete: job not in `awaiting_upload` (already completed upload step or wrong state).
- **400** from **upload-complete**: object not in R2 yet (HEAD failed) — finish the PUT first.
- **502** from **upload-complete**: R2 HEAD/GET error or failed stream to disk.
