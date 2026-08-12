import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * payouts — creator withdrawal requests, created when the user clicks Withdraw.
 * Min withdrawal ₹60 is enforced in code (optionally also a CHECK constraint).
 *
 * Manual settle (solo developer, no RazorpayX): the creator's saved UPI ID is
 * snapshotted onto `upiId` at request time, and the admin transfers via their
 * own UPI app, then marks the payout paid/failed.
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
      allowNull: true, // RazorpayX payout id (set on processing/paid) — unused in manual settle
      field: 'razorpay_payout_id',
    },
    bankAccountId: {
      type: DataTypes.UUID,
      allowNull: true, // legacy destination — manual settle now uses upiId
      references: { model: 'bank_accounts', key: 'id' },
      field: 'bank_account_id',
    },
    upiId: {
      type: DataTypes.STRING,
      allowNull: true, // snapshot of the UPI to pay to (set on create; nullable for old rows)
      field: 'upi_id',
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
