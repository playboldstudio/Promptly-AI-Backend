import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/**
 * user_posts — per-user publishing ledger. Drives the daily post limit and "My Prompts".
 * Daily limit = COUNT(*) WHERE user_id=? AND posted_on = today (no counter column).
 */
const UserPost = sequelize.define(
  'UserPost',
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
    promptId: {
      type: DataTypes.UUID,
      allowNull: true, // may hold a prompt without publishing a new catalog row
      references: { model: 'prompts', key: 'id' },
      field: 'prompt_id',
    },
    postedOn: {
      type: DataTypes.DATEONLY, // local date used for the daily limit
      allowNull: false,
      field: 'posted_on',
    },
  },
  {
    tableName: 'user_posts',
    timestamps: true,
    indexes: [
      { fields: ['user_id', 'posted_on'] }, // hot query: today's post count
    ],
  },
);

export default UserPost;
