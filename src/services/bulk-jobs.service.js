import crypto from 'node:crypto';
import { bulkUploadPrompts } from './bulk-prompts.service.js';

/**
 * Slice A â€” async bulk-import job (202 + jobId; worker runs off the request).
 *
 * Root-cause fix for the bulk timeout: with 100â€“500 prompts+images the work
 * is image-uploads (Storage) + batched Firestore writes. Running it inside the
 * POST latency means the request sits open past the Cloud Run deadline. Instead:
 *   POST  â†’ validate csvText SHAPE only (cheap) â†’ 202 { jobId } immediately
 *   worker â†’ bulkUploadPrompts (the SAME byte-verified greenslice importer)
 *   GET /bulk/jobs/:jobId â†’ { status, total, processed, succeeded, failed, errors[] }
 *
 * Idempotency: jobId = sha256(csvText). Re-posting the same CSV text returns
 * the SAME job (no duplicate prompts on retry â€” the money-safety half of A).
 * Concurrency is capped (MAX_ACTIVE) so 100â€“500 queues, never stacks.
 */
const jobs = new Map(); // jobId â†’ job state
const MAX_ACTIVE = 4;    // bounded background worker slots (money-batch arm)
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
    jobs.set(job.jobId, job.get ? job : transient(job));
  }
  const timer = setTimeout(() => jobs.delete(job.jobId), 6 * 60 * 60 * 1000); // cheap retention cap
  timer.unref?.();
}

/** Queues a slice-A bulk job. Returns { jobId, created, job } â€” never blocks. */
export function enqueueBulkJob({ csvText, imagesByName, userId, adminEmail }) {
  const jobId = crypto.createHash('sha256').update(csvText).digest('hex').slice(0, 24);
  const existing = jobs.get(jobId);
  if (existing && (existing.status === 'queued' || existing.status === 'running')) {
    return { jobId, created: false, job: publicJob(existing) };
  }
  if (existing) jobs.delete(jobId); // finished/failed â†’ fresh retry allowed

  const job = {
    jobId,
    status: 'queued',
    total: 0,
    processed: 0,
    succeeded: 0,
    failed: 0,
    errors: [],
    createdIds: [],
    startedAt: null,
    finishedAt: null,
    input: { csvText, imagesByName, userId, adminEmail },
  };
  jobs.set(jobId, job);
  // bounded: if all worker slots busy, stays 'queued' (poll GET), never 500s.
  if (active < MAX_ACTIVE) void runJob(job);
  return { jobId, created: true, job: publicJob(job) };
}

/** Public job snapshot for GET /bulk/jobs/:jobId. */
export function getBulkJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return { jobId, status: 'not_found' };
  return publicJob(job);
}

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