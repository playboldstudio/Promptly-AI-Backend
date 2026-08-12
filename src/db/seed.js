import './models.js'; // registers all models + associations
import { sequelize } from './config.js';
import {
  User,
  SubscriptionPlan,
  Prompt,
  BankAccount,
  KycVerification,
} from './models.js';

/**
 * `npm run db:seed` — idempotent starter data.
 *
 * Upserts (by primary key / unique field) so re-running is safe:
 *   - 3 subscription plans (free / pro / creator)
 *   - 1 demo creator user
 *   - 5 prompts (free + paid mix) authored by the demo creator
 *   - a verified KYC + a bank account for the demo creator, so the manual-settle
 *     payout flow is testable (request → admin marks paid)
 */

const PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceInr: 0,
    billingCycle: 'monthly',
    dailyPostLimit: 3,
    canPostPaid: false,
    platformFeePercent: 0,
  },
  {
    id: 'pro',
    name: 'Pro',
    priceInr: 49,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: false,
    platformFeePercent: 5,
  },
  {
    id: 'creator',
    name: 'Creator',
    priceInr: 99,
    billingCycle: 'monthly',
    dailyPostLimit: null, // unlimited
    canPostPaid: true,
    platformFeePercent: 0,
  },
];

const DEMO_EMAIL = 'demo@promptly.app';

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

async function main() {
  console.log('Seeding…');

  // 1. Subscription plans
  for (const plan of PLANS) {
    await SubscriptionPlan.upsert(plan);
  }
  console.log(`  ✅ ${PLANS.length} subscription plans`);

  // 2. Demo creator
  const [creator] = await User.findOrCreate({
    where: { email: DEMO_EMAIL },
    defaults: {
      authProviderId: DEMO_EMAIL,
      fullName: 'Demo Creator',
      role: 'creator',
    },
  });
  console.log('  ✅ demo creator user');

  // 3. Prompts (upsert by unique title so re-seeds don't duplicate)
  for (const prompt of PROMPTS) {
    await Prompt.findOrCreate({
      where: { title: prompt.title },
      defaults: { ...prompt, authorId: creator.id },
    });
  }
  console.log(`  ✅ ${PROMPTS.length} prompts`);

  // 4. Demo creator KYC (verified) so the payout flow's KYC gate passes
  await KycVerification.findOrCreate({
    where: { userId: creator.id },
    defaults: {
      fullName: creator.fullName,
      pan: 'DEMOPAN123', // hashed in production
      status: 'verified',
      submittedAt: new Date(),
      verifiedAt: new Date(),
    },
  });
  console.log('  ✅ demo creator KYC (verified)');

  // 5. Demo creator bank account (manual-settle destination)
  await BankAccount.findOrCreate({
    where: { userId: creator.id },
    defaults: {
      accountHolder: creator.fullName,
      bankName: 'HDFC Bank',
      accountNumberLast4: '4321',
      ifsc: 'HDFC0001234',
      accountNumberFull: '50100234567890', // TEST only — encrypt before prod
    },
  });
  console.log('  ✅ demo creator bank account');

  await sequelize.close();
  console.log('✅ Seed complete.');
}

main().catch(async (err) => {
  console.error('❌ Seed failed:', err.message);
  await sequelize.close().catch(() => {});
  process.exit(1);
});
