/**
 * Simple Admin User Creation - No interactive input, no strict validation
 * Run: node scripts/create-admin-simple.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { hashPassword } from '../utils/passwordHash.js';
import User from '../models/User.js';

dotenv.config();

async function createAdmin() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not found in .env');
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB\n');

    // Use credentials from environment
    const username = process.env.ADMIN_USERNAME || 'admin';
    const password = process.env.ADMIN_PASSWORD;

    if (!password) {
      throw new Error('ADMIN_PASSWORD not found in .env');
    }

    console.log('📝 Creating admin user with credentials from .env');
    console.log('Username:', username);
    console.log('Password: (from ADMIN_PASSWORD env var)\n');

    // Check if admin exists
    const existing = await User.findOne({ username: username.toLowerCase().trim() });
    if (existing) {
      console.log('⚠️  Admin user already exists:', existing.username);
      console.log('Role:', existing.role);
      console.log('Email:', existing.email || '(not set)');
      console.log('\nTo recreate, delete the existing user first:');
      console.log('db.users.deleteOne({ username: "' + username + '" })');
      await mongoose.disconnect();
      process.exit(0);
    }

    // Hash password (NO strict validation - accept any password from env)
    console.log('🔒 Hashing password...');
    const hashedPassword = await hashPassword(password);

    // Create admin with all permissions
    const allPermissions = [
      'orders:read', 'orders:create', 'orders:update', 'orders:delete', 'orders:sync', 'orders:print', 'orders:ship',
      'products:read', 'products:create', 'products:update', 'products:delete', 'products:sync',
      'finance:read', 'finance:create', 'finance:update', 'finance:delete',
      'system:settings', 'system:users', 'system:health', 'system:logs',
      'suppliers:read', 'suppliers:write', 'imports:read', 'imports:write',
      'customers:read', 'customers:write', 'chat:read', 'chat:write'
    ];

    const admin = new User({
      username: username.toLowerCase().trim(),
      password: hashedPassword,
      email: undefined, // No email for env-based admin
      role: 'admin',
      permissions: allPermissions, // Admin has all permissions
      isActive: true,
      createdBy: 'system'
    });

    await admin.save();

    console.log('\n✅ Admin user created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Username:', admin.username);
    console.log('Role:', admin.role);
    console.log('ID:', admin._id);
    console.log('\n⚠️  Use this username and ADMIN_PASSWORD to login');
    console.log('Password is from .env (ADMIN_PASSWORD)');

    await mongoose.disconnect();
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Error:', err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
}

createAdmin();
