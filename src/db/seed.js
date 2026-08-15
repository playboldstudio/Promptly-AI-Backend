import { pathToFileURL } from 'node:url';
import { COLS, findByPk, upsert } from '../db/firestoreRepo.js';

/**
 * `npm run db:seed` — idempotent starter data for Firestore:
 * 3 subscription plans, 5 prompts (free + paid), and a demo author.
 * Safe to re-run — existing docs are merged, not duplicated.
 */

const PLANS = [
  { id: 'free', name: 'Free', priceInr: 0, billingCycle: 'monthly', dailyPostLimit: 3, canPostPaid: false, platformFeePercent: 0 },
  { id: 'pro', name: 'Pro', priceInr: 49, billingCycle: 'monthly', dailyPostLimit: null, canPostPaid: true, platformFeePercent: 5 },
  { id: 'creator', name: 'Creator', priceInr: 99, billingCycle: 'monthly', dailyPostLimit: null, canPostPaid: true, platformFeePercent: 0 },
];

const DEMO_USER_ID = 'demo_creator';

const PROMPTS = [
  {
    title: 'Golden Hour Portrait',
    description: 'Cinematic portrait lighting prompt for warm, film-like tones.',
    promptText: 'A studio portrait of a woman, golden hour sunlight, shallow depth of field, 85mm lens, film grain, Kodak Portra 400 tones, soft shadows.',
    imageUrl: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=800',
    category: 'portrait',
    tags: ['portrait', 'golden-hour', 'film'],
    isPaid: false,
    priceInr: null,
    status: 'published',
    viewCount: 128,
    saveCount: 42,
  },
  {
    title: 'Neon City Nights',
    description: 'Cyberpunk street scene with neon reflections on wet asphalt.',
    promptText: 'A rainy neon-lit city street at night, cyberpunk aesthetic, reflective wet asphalt, vibrant magenta and cyan neon signs, cinematic wide shot, ultra-detailed.',
    imageUrl: 'https://images.unsplash.com/photo-1518005020951-eccb494ad742?w=800',
    category: 'cinematic',
    tags: ['cyberpunk', 'neon', 'night', 'cinematic'],
    isPaid: true,
    priceInr: 49,
    status: 'published',
    viewCount: 421,
    saveCount: 173,
  },
  {
    title: 'High-Fashion Editorial',
    description: 'Magazine-quality fashion shot with dramatic studio contrast.',
    promptText: 'High-fashion editorial photograph, dramatic studio lighting, stark contrast, minimalist backdrop, avant-garde couture, shot on medium format, Vogue aesthetic.',
    imageUrl: 'https://images.unsplash.com/photo-1483985988355-763728e1935b?w=800',
    category: 'fashion',
    tags: ['fashion', 'editorial', 'studio'],
    isPaid: true,
    priceInr: 99,
    status: 'published',
    viewCount: 356,
    saveCount: 121,
  },
  {
    title: 'Tropical Product Shot',
    description: 'Bright, airy e-commerce product photography on a clean background.',
    promptText: 'Minimalist product photography of a skincare bottle, tropical leaves, bright airy background, soft natural light, e-commerce style, crisp detail.',
    imageUrl: 'https://images.unsplash.com/photo-1556228720-195a672e8a03?w=800',
    category: 'product',
    tags: ['product', 'ecommerce', 'minimal'],
    isPaid: false,
    priceInr: null,
    status: 'published',
    viewCount: 98,
    saveCount: 27,
  },
  {
    title: 'Mountain Travel Vlog',
    description: 'Breathtaking mountain landscape with dramatic scale.',
    promptText: 'A sweeping mountain landscape at sunrise, dramatic cloud layers, tiny hiker for scale, epic wide-angle shot, crisp morning light, travel photography.',
    imageUrl: 'https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=800',
    category: 'travel',
    tags: ['travel', 'mountain', 'landscape'],
    isPaid: false,
    priceInr: null,
    status: 'published',
    viewCount: 214,
    saveCount: 88,
  },
];

/** Deterministic prompt doc id from the title (stable across re-seeds). */
function slug(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  console.log('Seeding Firestore…');

  for (const plan of PLANS) {
    await upsert(COLS.subscriptionPlans, plan.id, {
      ...plan,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  console.log(`  ✅ ${PLANS.length} subscription plans`);

  // Demo author user (matches the demo creator).
  await upsert(COLS.users, DEMO_USER_ID, {
    authProviderId: 'demo@promptly.app',
    email: 'demo@promptly.app',
    fullName: 'Demo Creator',
    role: 'creator',
    upiId: 'demo@upi',
    avatarUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  console.log('  ✅ demo creator user');

  for (const prompt of PROMPTS) {
    const id = slug(prompt.title);
    await upsert(COLS.prompts, id, {
      ...prompt,
      authorId: DEMO_USER_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  console.log(`  ✅ ${PROMPTS.length} prompts`);

  console.log('✅ Seed complete.');
}

export default main;

// Run directly (`node src/db/seed.js`) or via `npm run db:seed`.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('❌ Seed failed:', err.message);
    process.exit(1);
  });
}
