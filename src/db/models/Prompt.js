import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/** prompts — the catalog (free + paid). Maps 1:1 to the UI `Prompt` model. */
const Prompt = sequelize.define(
  'Prompt',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    authorId: {
      type: DataTypes.UUID,
      allowNull: true, // nullable — seeded/app prompts
      references: { model: 'users', key: 'id' },
      field: 'author_id',
    },
    title: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    promptText: {
      type: DataTypes.TEXT,
      allowNull: false,
      field: 'prompt_text',
    },
    imageUrl: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'image_url', // cloud storage URL (S3 / Firebase Storage)
    },
    category: {
      type: DataTypes.ENUM(
        'portrait',
        'fashion',
        'cinematic',
        'product',
        'travel',
        'creative',
        'social',
        'photography',
        'other',
      ),
      allowNull: false,
    },
    tags: {
      type: DataTypes.ARRAY(DataTypes.STRING),
      allowNull: false,
      defaultValue: [], // for search
    },
    isPaid: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
      field: 'is_paid',
    },
    priceInr: {
      type: DataTypes.INTEGER,
      allowNull: true, // NULL when is_paid = false
      field: 'price_inr',
    },
    status: {
      type: DataTypes.ENUM('draft', 'published', 'archived'),
      allowNull: false,
      defaultValue: 'draft',
    },
    // NOTE: is_trending / is_new are NOT stored — they are derived at read time
    // (engagement = view_count + save_count; age = created_at). See
    // src/services/prompt-metrics.js.
    viewCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'view_count',
    },
    saveCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      field: 'save_count',
    },
  },
  {
    tableName: 'prompts',
    timestamps: true,
    indexes: [
      { fields: ['category', 'is_paid'] }, // hot query: browse by category
      { fields: ['created_at'] }, // "New" sort
      { fields: ['status'] }, // published-filtered reads
    ],
  },
);

export default Prompt;
