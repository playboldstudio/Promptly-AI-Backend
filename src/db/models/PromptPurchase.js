import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * prompt_purchases — one row per successful Razorpay Checkout.
 * Financial snapshot frozen at sale time (price/fee/net) so history survives fee changes.
 * Unique (buyer_id, prompt_id) → one unlock per buyer per prompt.
 */
const PromptPurchase = sequelize.define(
  'PromptPurchase',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    buyerId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      field: 'buyer_id',
    },
    promptId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'prompts', key: 'id' },
      field: 'prompt_id',
    },
    authorId: {
      type: DataTypes.UUID,
      allowNull: false, // denormalized for fast "earnings per prompt" queries
      references: { model: 'users', key: 'id' },
      field: 'author_id',
    },
    priceInr: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'price_inr',
    },
    platformFeeInr: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'platform_fee_inr',
    },
    netInr: {
      type: DataTypes.INTEGER,
      allowNull: false, // price − fee credited to creator
      field: 'net_inr',
    },
    razorpayPaymentId: {
      type: DataTypes.STRING,
      allowNull: false, // idempotency / audit link
      field: 'razorpay_payment_id',
    },
    status: {
      type: DataTypes.ENUM('completed', 'refunded'),
      allowNull: false,
      defaultValue: 'completed',
    },
  },
  {
    tableName: 'prompt_purchases',
    timestamps: true,
    indexes: [
      { fields: ['author_id'] }, // hot query: creator earnings
      { fields: ['prompt_id'] },
      { unique: true, fields: ['buyer_id', 'prompt_id'] }, // one unlock per buyer per prompt
    ],
  },
);

export default PromptPurchase;
