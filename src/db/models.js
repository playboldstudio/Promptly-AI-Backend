import { sequelize } from './config.js';
import User from './models/User.js';
import SubscriptionPlan from './models/SubscriptionPlan.js';
import UserSubscription from './models/UserSubscription.js';
import Prompt from './models/Prompt.js';
import UserPost from './models/UserPost.js';
import PromptPurchase from './models/PromptPurchase.js';
import Transaction from './models/Transaction.js';
import Payout from './models/Payout.js';
import BankAccount from './models/BankAccount.js';
import KycVerification from './models/KycVerification.js';
import SavedPrompt from './models/SavedPrompt.js';
import WebhookEvent from './models/WebhookEvent.js';

// ---------------------------------------------------------------------------
// Associations — the design-doc relationship map.
// ---------------------------------------------------------------------------

// users 1:N user_posts
User.hasMany(UserPost, { as: 'posts', foreignKey: 'userId' });
UserPost.belongsTo(User, { as: 'user', foreignKey: 'userId' });

// users 1:N saved_prompts (many-to-many via join table)
User.hasMany(SavedPrompt, { as: 'savedEntries', foreignKey: 'userId' });
Prompt.hasMany(SavedPrompt, { as: 'savedBy', foreignKey: 'promptId' });
SavedPrompt.belongsTo(User, { as: 'user', foreignKey: 'userId' });
SavedPrompt.belongsTo(Prompt, { as: 'prompt', foreignKey: 'promptId' });

// users 1:N user_subscriptions, subscription_plans 1:N user_subscriptions
User.hasMany(UserSubscription, { as: 'subscriptions', foreignKey: 'userId' });
SubscriptionPlan.hasMany(UserSubscription, { as: 'userSubscriptions', foreignKey: 'planId' });
UserSubscription.belongsTo(User, { as: 'user', foreignKey: 'userId' });
UserSubscription.belongsTo(SubscriptionPlan, { as: 'plan', foreignKey: 'planId' });

// prompts N:1 users (author) — nullable for seeded prompts
User.hasMany(Prompt, { as: 'authoredPrompts', foreignKey: 'authorId' });
Prompt.belongsTo(User, { as: 'author', foreignKey: 'authorId' });

// users 1:N user_posts → prompts (a post may reference a catalog prompt)
Prompt.hasMany(UserPost, { as: 'posts', foreignKey: 'promptId' });
UserPost.belongsTo(Prompt, { as: 'prompt', foreignKey: 'promptId' });

// prompt_purchases: buyer + author (two FKs to users), plus prompt
Prompt.hasMany(PromptPurchase, { as: 'purchases', foreignKey: 'promptId' });
PromptPurchase.belongsTo(Prompt, { as: 'prompt', foreignKey: 'promptId' });
User.hasMany(PromptPurchase, { as: 'purchases', foreignKey: 'buyerId' });
PromptPurchase.belongsTo(User, { as: 'buyer', foreignKey: 'buyerId' });
User.hasMany(PromptPurchase, { as: 'sales', foreignKey: 'authorId' });
PromptPurchase.belongsTo(User, { as: 'author', foreignKey: 'authorId' });

// users 1:N transactions
User.hasMany(Transaction, { as: 'transactions', foreignKey: 'userId' });
Transaction.belongsTo(User, { as: 'user', foreignKey: 'userId' });

// users 1:N payouts, bank_accounts 1:N payouts
User.hasMany(Payout, { as: 'payouts', foreignKey: 'userId' });
BankAccount.hasMany(Payout, { as: 'payouts', foreignKey: 'bankAccountId' });
Payout.belongsTo(User, { as: 'user', foreignKey: 'userId' });
Payout.belongsTo(BankAccount, { as: 'bankAccount', foreignKey: 'bankAccountId' });

// users 1:N bank_accounts
User.hasMany(BankAccount, { as: 'bankAccounts', foreignKey: 'userId' });
BankAccount.belongsTo(User, { as: 'user', foreignKey: 'userId' });

// users 1:1 kyc_verifications
User.hasOne(KycVerification, { as: 'kyc', foreignKey: 'userId' });
KycVerification.belongsTo(User, { as: 'user', foreignKey: 'userId' });

// WebhookEvent is standalone — no relations needed.

export {
  sequelize,
  User,
  SubscriptionPlan,
  UserSubscription,
  Prompt,
  UserPost,
  PromptPurchase,
  Transaction,
  Payout,
  BankAccount,
  KycVerification,
  SavedPrompt,
  WebhookEvent,
};
