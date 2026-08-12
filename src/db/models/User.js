import { DataTypes } from 'sequelize';
import { sequelize } from '../config.js';

/** users — signed-in account. Auth identity is external (Firebase/Supabase); we store a reference. */
const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      defaultValue: DataTypes.UUIDV4,
    },
    authProviderId: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true, // UID from Firebase/Supabase
      field: 'auth_provider_id',
    },
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    fullName: {
      type: DataTypes.STRING,
      allowNull: false,
      field: 'full_name',
    },
    avatarUrl: {
      type: DataTypes.STRING,
      allowNull: true,
      field: 'avatar_url',
    },
    role: {
      type: DataTypes.ENUM('viewer', 'creator'),
      allowNull: false,
      defaultValue: 'viewer',
    },
  },
  {
    tableName: 'users',
    timestamps: true,
  },
);

export default User;
