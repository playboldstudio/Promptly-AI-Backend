import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/** user_subscriptions — current + historical subscriptions per user. */
const UserSubscription = sequelize.define(
  'UserSubscription',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      references: { model: 'users', key: 'id' },
      field: 'user_id',
    },
    planId: {
      type: DataTypes.STRING,
      allowNull: false,
      references: { model: 'subscription_plans', key: 'id' },
      field: 'plan_id',
    },
    razorpaySubId: {
      type: DataTypes.STRING,
      allowNull: true, // nullable for free plan
      field: 'razorpay_sub_id',
    },
    status: {
      type: DataTypes.ENUM('active', 'cancelled', 'past_due', 'expired'),
      allowNull: false,
      defaultValue: 'active',
    },
    currentPeriodStart: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'current_period_start',
    },
    currentPeriodEnd: {
      type: DataTypes.DATE,
      allowNull: false,
      field: 'current_period_end',
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'cancelled_at',
    },
  },
  {
    tableName: 'user_subscriptions',
    timestamps: true,
  },
);

export default UserSubscription;
