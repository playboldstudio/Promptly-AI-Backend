import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * bank_accounts — creator payout destination (from the KYC flow).
 *
 * ⚠️ SECURITY: manual settle (solo developer, no RazorpayX) stores the FULL
 * account number so the admin can transfer via their own bank app. That is
 * plaintext today — acceptable for TEST mode only. ENCRYPT the column before
 * real money flows (see README "Before launch").
 */
const BankAccount = sequelize.define(
  'BankAccount',
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
    accountHolder: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'account_holder',
    },
    bankName: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'bank_name',
    },
    accountNumberLast4: {
      type: DataTypes.STRING,
      allowNull: false, // only the last 4 digits stored
      field: 'account_number_last4',
    },
    ifsc: {
      type: DataTypes.STRING(11),
      allowNull: false,
    },
    razorpayFundAccountId: {
      type: DataTypes.STRING,
      allowNull: true, // RazorpayX fund account reference — null for manual settle
      field: 'razorpay_fund_account_id',
    },
    accountNumberFull: {
      type: DataTypes.STRING,
      allowNull: true, // full account number — MANUAL SETTLE only; see class doc
      field: 'account_number_full',
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
      field: 'is_active',
    },
  },
  {
    tableName: 'bank_accounts',
    timestamps: true,
    indexes: [
      { fields: ['user_id'] },
    ],
  },
);

export default BankAccount;
