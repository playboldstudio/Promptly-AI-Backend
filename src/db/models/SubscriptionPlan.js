import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/** subscription_plans — static catalog of the three tiers (matches the UI SubscriptionPlan enum). */
const SubscriptionPlan = sequelize.define(
  'SubscriptionPlan',
  {
    id: {
      type: DataTypes.STRING, // "free" | "pro" | "creator"
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    priceInr: {
      type: DataTypes.INTEGER, // 0 / 49 / 99 — integer rupees, never floats
      allowNull: false,
      field: 'price_inr',
    },
    billingCycle: {
      type: DataTypes.ENUM('monthly'), // add 'yearly' later
      allowNull: false,
      defaultValue: 'monthly',
      field: 'billing_cycle',
    },
    dailyPostLimit: {
      type: DataTypes.INTEGER,
      allowNull: true, // NULL = unlimited
      field: 'daily_post_limit',
    },
    canPostPaid: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'can_post_paid',
    },
    platformFeePercent: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0, // 0 / 5
      field: 'platform_fee_percent',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'is_active',
    },
  },
  {
    tableName: 'subscription_plans',
    timestamps: true,
  },
);

export default SubscriptionPlan;
