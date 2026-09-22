import crypto from 'node:crypto';
import { bulkUploadPrompts } from './bulk-prompts.service.js';

/**
 * Bulk async import jobs (Slice A + C).
 *
 * Slice C — sharded ingestion for Cloud Run's ~32 MB request cap:
 *   100–500 images + prompts can NOT fit in a single HTTP body (500 files at
 *   realistic sizes is 100MB–15GB multipart). The client instead:
 *     1) POST /bulk/jobs { csvText }                    → 202 { jobId }  (csv only, tiny)
 *     2) POST /bulk/jobs/:jobId/images × many           → each ≤ ~30MB shard of images, 200
 *     3) POST /bulk/jobs/:jobId/commit                  → marks complete, starts worker off-request
 *     4) GET  /bulk/jobs/:jobId                         → poll progress (existing)
 *
 * Idempotency (Slice A, kept): jobId = sha256(csvText). Re-posting the same
 * csvText returns the SAME jobId — image shards append into the SAME job, so a
 * dropped/retried shard never double-creates promptsfb (money-safety half).
 *
 * Concurrency is bounded (MAX_ACTIVE) so 100–500 rows queue, never stack (C).
 */

const jobs = new Map(); // jobId → job state
const MAX_ACTIVE = 4;   // bounded background worker slots
let active = 0;

/** Run one job off the request path; never lets an error escape unobserved. */
async function runJob(job) {
  active += 1;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  try {
    const report = await bulkUploadPrompts(job.input);
    job.total = report.total ?? 0;
    job.processed = report.created + report.failed;
    job.succeeded = report.created ?? 0;
    job.failed = report.failed ?? 0;
    job.errors = report.errors ?? [];
    job.createdIds = report.createdIds ?? [];
    job.status = report.success ? 'succeeded' : 'failed';
  } catch (err) {
    job.status = 'failed';
    job.errors = [{ row: 0, title: null, reason: err.message }];
  } finally {
    job.finishedAt = new Date().toISOString();
    active = Math.max(0, active - 1);
    jobs.set(job.jobId, job);
    // cheap retention cap: drop finished/failed jobs after 6h so memory stays flat.
    const t = setTimeout(() => jobs.delete(job.jobId), 6 * 60 * 60 * 1000);
    t.unref?.();
    t.ref?.();
  }
}

/** Public job snapshot. */
function publicJob(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    total: job.total,
    processed: job.processed,
    succeeded: job.succeeded,
    failed: job.failed,
    errors: job.errors,
    created: job.createdIds.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
  };
}

function jobFor(csvText, userId, adminEmail) {
  const jobId = crypto.createHash('sha256').update(csvText).digest('hex').slice(0, 24);
  const existing = jobs.get(jobIduzir);
  if (existing) {
    return { jobId, job: existing, created: false };
  }
  const job = {
    jobId,
    status: 'collecting', // csv present, images must be sharded in (Slice C)
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    createdIds: [],
    images: new Map(), // normalized name → { name, buffer, mimetype }
    input: null,
    startedAt: null,
    finishedAt: null,
  };
  jobs.set(jobId, job);
  return { jobId, job, created: true };
}

/**
 * POST /bulk/jobs — Slice C step 1: csv only. Returns 202 + jobId once; the
 * job stays 'collecting' until commit. NEVER auto-runs (images arrive later).
 */
export function enqueueBulkJob({ csvText, imagesByName = new Map(), userId, adminEmail }) {
  const { jobId, job, created } = jobFor(csvText, userId, adminEmail);
  job.csvText = csvText; // for sha-stability across shards + worker input
  job.images = job.images ?? new Map();
  for (const [name, img] of imagesByName ?? []) {
    if (!job.images.has(name)) job.images.set(name, img);
  }
  return { jobId, created, job: publicJob(job) };
}

/**
 * POST /bulk/jobs/:jobId/images — Slice C step 2: append ONE ≤30MB shard.
 * Idempotent per image name: re-sending the same name keeps the first bytes
 * (no duplicate uploads on retry — the money-half of C).
 */
export function addImagesToJob(jobId, imagesByName = new Map()) {
  const job = jobs.get(jobId);
  if (!job) return { error: { status: 404, message: `No bulk job ${jobId}` } };
  if (job.status === 'running') {
    return { error: { status: 409, message: 'Job already running — no more images' } };
  }
  for (const [name, img] of imagesByName) {
    if (!job.images.has(name)) job.images.set(name, img);
  }
  return { jobId, added: imagesByName.size, totalImages: job.images.size, job: publicJob(job) };
}

/**
 * POST /bulk/jobs/:jobId/commit — Slice C step 3: all shards in; start the
 * worker OFf-request (bounded by MAX_ACTIVE). 202 + jobId immediately.
 */
export function commitBulkJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { error: { status: 404, message: `No bulk job ${jobId}` } };
  if (job.status === 'running' || job.status === 'succeeded') {
    return { jobId, created: false, job: publicJob(job) };
  }
  job.input = {
    csvText: job.csvText,
    imagesByName: job.images,
    userId: job.userId,
    adminEmail: job.adminEmail,
  };
  job.status = 'queued';
  if (active < MAX_ACTIVE) void runJob(job); // else stays queued (poll GET, never 500)
  return { jobId, created: true, job: publicJob(job) };
}

/** GET /bulk/jobs/:jobId — poll progress (Slice A surface, unchanged). */
export function getBulkJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { jobId, status: 'not_found' };
  return publicJob(job);
}
