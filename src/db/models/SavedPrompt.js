import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/** saved_prompts — join table for the "Saved" screen (many-to-many user ↔ prompt). */
const SavedPrompt = sequelize.define(
  'SavedPrompt',
  {
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true, // composite PK (user_id, prompt_id)
      references: { model: 'users', key: 'id' },
      field: 'user_id',
    },
    promptId: {
      type: DataTypes.UUID,
      allowNull: false,
      primaryKey: true,
      references: { model: 'prompts', key: 'id' },
      field: 'prompt_id',
    },
    savedAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW,
      field: 'saved_at',
    },
  },
  {
    tableName: 'saved_prompts',
    timestamps: false,
  },
);

export default SavedPrompt;
