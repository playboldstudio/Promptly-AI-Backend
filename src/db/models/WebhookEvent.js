import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * webhook_events — log of every inbound Razorpay webhook. Design-doc §5 recommendation:
 * webhooks must be idempotent and replayable, so we log every payload.
 */
const WebhookEvent = sequelize.define(
  'WebhookEvent',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    provider: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'razorpay',
    },
    eventName: {
      type: DataTypes.STRING,
      allowNull: false, // e.g. "subscription.charged"
      field: 'event_name',
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false,
    },
    razorpaySignature: {
      type: DataTypes.STRING,
      allowNull: true, // raw X-Razorpay-Signature header for later verification
      field: 'razorpay_signature',
    },
    dedupeKey: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // sha256(event_name | payload) — replay guard
      field: 'dedupe_key',
    },
    processedAt: {
      type: DataTypes.DATE,
      allowNull: true, // set when the event is handled (idempotency guard)
      field: 'processed_at',
    },
  },
  {
    tableName: 'webhook_events',
    timestamps: true,
    indexes: [
      { fields: ['provider', 'created_at'] },
    ],
  },
);

export default WebhookEvent;
