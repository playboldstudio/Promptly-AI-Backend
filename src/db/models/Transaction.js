import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * transactions — the "My Account" ledger. Every credit/debit for a user.
 * This is the table the current UI screen renders.
 * balance_after_inr = running balance snapshot for an audit trail without recomputation.
 */
const Transaction = sequelize.define(
  'Transaction',
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
    type: {
      type: DataTypes.ENUM('paid_prompt_sale', 'subscription_payment', 'payout', 'refund'),
      allowNull: false,
    },
    direction: {
      type: DataTypes.ENUM('credit', 'debit'),
      allowNull: false,
    },
    amountInr: {
      type: DataTypes.INTEGER,
      allowNull: false, // positive always; sign from direction
      field: 'amount_inr',
    },
    balanceAfterInr: {
      type: DataTypes.INTEGER,
      allowNull: false,
      field: 'balance_after_inr',
    },
    refId: {
      type: DataTypes.STRING,
      allowNull: true, // id of prompt_purchases / user_subscriptions / payouts
      field: 'ref_id',
    },
    note: {
      type: DataTypes.STRING,
      allowNull: false, // human-readable line shown in the app
    },
  },
  {
    tableName: 'transactions',
    timestamps: true,
    indexes: [
      { fields: ['user_id', 'created_at'] }, // hot query: ledger by user
    ],
  },
);

export default Transaction;
