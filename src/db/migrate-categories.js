import { pathToFileURL } from 'node:url';
import { COLS, update, queryAll } from './firestoreRepo.js';
import { PROMPT_CATEGORIES } from '../utils/prompt-import.js';

/**
 * `npm run db:migrate-categories` — one-time, idempotent migration when the
 * prompt category enum changes (style-driven taxonomy: portrait · studio ·
 * vintage · retro · cinematic · anime · art · birthday · festive · other).
 *
 * Removed categories are remapped to their new-style home:
 *   photography → portrait   (photo quality/enhancement → portrait looks)
 *   creative    → art        (the artistic/craft bucket)
 *   fashion     → studio     (magazine/editorial looks → studio)
 *   travel      → vintage    (scenic/road-trip looks → vintage film frames)
 *   product     → studio     (commercial/e-commerce shots → studio lighting)
 *   social      → other      (mixed social-moment posts → fallback bucket)
 *
 * Idempotency: only prompts whose `category` is NOT in the current enum are
 * touched; anything already valid is left alone, so re-running is a no-op.
 */

// Old → new category map (only for categories removed from the enum).
const REMAP = {
  photography: 'portrait',
  creative: 'art',
  fashion: 'studio',
  travel: 'vintage',
  product: 'studio',
  social: 'other',
};

async function main() {
  console.log('Migrating prompt categories → new taxonomy…');

  const { rows } = await queryAll({ collection: COLS.prompts, limit: 10000 });
  const candidates = rows.filter((r) => !PROMPT_CATEGORIES.includes(r.category));
  console.log(`  ${rows.length} prompts, ${candidates.length} with a removed category`);

  let migrated = 0;
  let skipped = 0;
  for (const prompt of candidates) {
    const next = REMAP[prompt.category];
    if (!next) {
      // Not a known removed category — leave it for manual review.
      skipped += 1;
      console.log(`  ⚠  ${prompt.id}: unknown category "${prompt.category}" — left as-is`);
      continue;
    }
    await update(COLS.prompts, prompt.id, {
      category: next,
      updatedAt: new Date(),
    });
    migrated += 1;
    console.log(`  ${prompt.id}: "${prompt.category}" → "${next}"`);
  }

  console.log(`✅ Category migration complete — ${migrated} remapped, ${skipped} skipped.`);
}

export default main;

// Run directly (`node src/db/migrate-categories.js`) or via `npm run db:migrate-categories`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  });
}