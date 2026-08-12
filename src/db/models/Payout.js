import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * payouts — creator withdrawal requests, created when the user clicks Withdraw.
 * Min withdrawal ₹60 is enforced in code (optionally also a CHECK constraint).
 */
const Payout = sequelize.define(
  'Payout',
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
    amountInr: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'amount_inr',
    },
    status: {
      type: DataTypes.ENUM('pending', 'processing', 'paid', 'failed'),
      allowNull: false,
      defaultValue: 'pending', // drives the "Processing → Paid" badge
    },
    razorpayPayoutId: {
      type: DataTypes.STRING,
      allowNull: true, // RazorpayX payout id (set on processing/paid)
      field: 'razorpay_payout_id',
    },
    bankAccountId: {
      type: DataTypes.UUID,
      allowNull: false, // snapshot of destination
      references: { model: 'bank_accounts', key: 'id' },
      field: 'bank_account_id',
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'processed_at',
    },
    failureReason: {
      type: DataTypes.STRING,
      allowNull: true, // set when a payout fails (admin note)
      field: 'failure_reason',
    },
  },
  {
    tableName: 'payouts',
    timestamps: true,
    indexes: [
      { fields: ['user_id'] },
    ],
  },
);

export default Payout;
