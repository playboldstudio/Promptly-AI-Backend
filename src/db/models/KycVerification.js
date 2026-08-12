import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * kyc_verifications — KYC state for creators who want payouts.
 * PAN is stored hashed/encrypted in production (this is a plain column for dev).
 * rejected state + rejection_reason lets users fix and resubmit instead of being stuck.
 */
const KycVerification = sequelize.define(
  'KycVerification',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true, // 1:1 with users
      references: { model: 'users', key: 'id' },
      field: 'user_id',
    },
    fullName: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'full_name', // as on PAN
    },
    pan: {
      type: DataTypes.STRING(10),
      allowNull: false, // store hashed/encrypted in production
    },
    status: {
      type: DataTypes.ENUM('not_submitted', 'pending', 'verified', 'rejected'),
      allowNull: false,
      defaultValue: 'not_submitted',
    },
    razorpayContactId: {
      type: DataTypes.STRING,
      allowNull: true, // RazorpayX contact/fund account reference
      field: 'razorpay_contact_id',
    },
    submittedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'submitted_at',
    },
    verifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
      field: 'verified_at',
    },
    rejectionReason: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'rejection_reason',
    },
  },
  {
    tableName: 'kyc_verifications',
    timestamps: true,
  },
);

export default KycVerification;
