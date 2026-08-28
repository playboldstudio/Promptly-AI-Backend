#!/usr/bin/env node
/**
 * Apply missing composite indexes from firestore.indexes.json to a Firestore
 * database, idempotently, using the gcloud CLI (ADC / workload identity).
 *
 * Usage:
 *   node scripts/deploy-firestore-indexes.mjs --database=promptly-ai
 *   node scripts/deploy-firestore-indexes.mjs --database=promptly-dev
 *
 * Reads the same config `firebase deploy --only firestore` would use, but works
 * non-interactively against named databases, so CI can keep indexes in sync
 * without the Firebase CLI or a manual step. Skips any index that already
 * exists on the target database; `__name__` auto-field is ignored when
 * comparing, as Firestore appends it to every composite index.
 *
 * Requires the gcloud CLI authenticated (e.g. via google-github-actions/auth).
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Parse --database=... (or --database ...) from argv. */
function parseArgs(argv) {
  let database = '(default)';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--database') database = argv[++i];
    else if (a.startsWith('--database=')) database = a.slice('--database='.length);
  }
  return database;
}

/**
 * Run gcloud, returning parsed JSON stdout.
 * `shell: true` makes this resolve gcloud on Windows (gcloud.cmd) and Linux alike.
 */
function gcloudJson(args, { allowFail = false } = {}) {
  let out;
  try {
    out = execFileSync('gcloud', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });
  } catch (err) {
    if (allowFail) return [];
    const msg = err.stderr?.toString?.()?.trim() || err.message;
    throw new Error(`gcloud ${args.join(' ')} failed: ${msg}`);
  }
  return JSON.parse(out || '[]');
}

/** Normalize an index's fields for comparison, dropping __name__ auto-field. */
function normalizeFields(fields = []) {
  return fields
    .filter((f) => f.fieldPath !== '__name__')
    .map((f) => ({
      fieldPath: f.fieldPath,
      order: f.order ?? null,
      arrayConfig: f.arrayConfig ?? f.array_config ?? null,
    }));
}

/** Signature for identity comparison (collectionGroup + queryScope + fields). */
function signature(index) {
  const fields = normalizeFields(index.fields)
    .map((f) => `${f.fieldPath}:${f.arrayConfig ?? f.order}`)
    .join('|');
  return `${index.collectionGroup}#${(index.queryScope || 'COLLECTION').toUpperCase()}#${fields}`;
}

/** Build gcloud --field-config args for one index field. */
function fieldConfigArgs(f) {
  if (f.arrayConfig) return ['--field-config', `field-path=${f.fieldPath},array-config=${f.arrayConfig}`];
  const order = (f.order || 'ASCENDING').toLowerCase();
  return ['--field-config', `field-path=${f.fieldPath},order=${order}`];
}

async function main() {
  const database = parseArgs(process.argv.slice(2));
  const project = process.env.GCP_PROJECT || process.env.PROJECT_ID || null;

  const { indexes = [] } = JSON.parse(readFileSync(path.join(ROOT, 'firestore.indexes.json'), 'utf8'));

  // Gather existing composite indexes on the target database.
  const existingArgs = ['firestore', 'indexes', 'composite', 'list', '--format=json'];
  if (project) existingArgs.push('--project', project);
  existingArgs.push('--database', database);
  const existing = gcloudJson(existingArgs, { allowFail: true });
  const existingSigs = new Set((Array.isArray(existing) ? existing : []).map(signature));

  console.log(`Applying Firestore composite indexes -> database "${database}"`);

  let created = 0;
  let skipped = 0;
  for (const index of indexes) {
    const sig = signature(index);
    if (existingSigs.has(sig)) {
      console.log(`  ✔ exists  ${index.collectionGroup} [${sig}]`);
      skipped++;
      continue;
    }

    const createArgs = [
      ...(project ? ['--project', project] : []),
      'firestore', 'indexes', 'composite', 'create',
      '--query-scope', (index.queryScope || 'COLLECTION').toLowerCase(),
      '--collection-group', index.collectionGroup,
      ...index.fields.flatMap(fieldConfigArgs),
      '--database', database,
      '--async',
    ];

    try {
      gcloudJson(createArgs);
      console.log(`  ➕ created ${index.collectionGroup} [${sig}]`);
      created++;
    } catch (err) {
      // A concurrent deploy may have just created it (409 / ALREADY_EXISTS) —
      // that's fine. Any other failure (auth, bad config) must fail the deploy.
      if (/failedPrecondition|ALREADY_EXISTS|409|already exists/i.test(err.message)) {
        console.log(`  ✔ exists (created concurrently) ${index.collectionGroup} [${sig}]`);
        skipped++;
      } else {
        throw err;
      }
    }
  }

  console.log(`\nDone: ${created} created/requested, ${skipped} already present.`);
  // Firestore builds indexes asynchronously — a short-lived CI token may not see
  // the final state, so treat a successful create request as a success.
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
