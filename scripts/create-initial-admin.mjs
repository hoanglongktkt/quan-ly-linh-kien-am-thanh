/**
 * Migration Script: Create Initial Admin User in Database
 * Run: node scripts/create-initial-admin.mjs
 */
import mongoose from 'mongoose';
import dotenv from 'dotenv';
import { hashPassword, validatePasswordStrength } from '../utils/passwordHash.js';
import User from '../models/User.js';
import readline from 'readline';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function createInitialAdmin() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI;
    if (!mongoUri) {
      throw new Error('MONGODB_URI not found in environment variables');
    }

    console.log('🔌 Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('✅ Connected to MongoDB');

    // Check if any admin exists
    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      console.log('⚠️  Admin user already exists:', existingAdmin.username);
      const confirm = await question('Do you want to create another admin? (yes/no): ');
      if (confirm.toLowerCase() !== 'yes' && confirm.toLowerCase() !== 'y') {
        console.log('❌ Cancelled');
        rl.close();
        await mongoose.disconnect();
        process.exit(0);
      }
    }

    // Get admin credentials
    console.log('\n📝 Create Initial Admin User');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    const username = await question('Username (lowercase, 3-50 chars): ');
    const email = await question('Email (optional): ');
    const password = await question('Password (min 16 chars, strong): ');

    // Validate
    if (!username || username.length < 3) {
      throw new Error('Username must be at least 3 characters');
    }

    // Check if username exists
    const existing = await User.findOne({ username: username.toLowerCase().trim() });
    if (existing) {
      throw new Error(`Username "${username}" already exists`);
    }

    // Validate password
    const validation = validatePasswordStrength(password);
    if (!validation.valid) {
      console.error('\n❌ Password not strong enough:');
      validation.errors.forEach(err => console.error('  - ' + err));
      rl.close();
      await mongoose.disconnect();
      process.exit(1);
    }

    // Hash password
    console.log('\n🔒 Hashing password...');
    const hashedPassword = await hashPassword(password);

    // Create admin user
    const admin = new User({
      username: username.toLowerCase().trim(),
      password: hashedPassword,
      email: email?.trim() || undefined,
      role: 'admin',
      permissions: ['*'], // Admin has all permissions
      isActive: true,
      createdBy: 'system'
    });

    await admin.save();

    console.log('\n✅ Admin user created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Username:', admin.username);
    console.log('Role:', admin.role);
    console.log('Email:', admin.email || '(not set)');
    console.log('ID:', admin._id);
    console.log('\n⚠️  IMPORTANT: Save your password securely!');
    console.log('This is the only time you will see it.');

    rl.close();
    await mongoose.disconnect();
    process.exit(0);

  } catch (err) {
    console.error('\n❌ Error creating admin user:', err.message);
    rl.close();
    await mongoose.disconnect();
    process.exit(1);
  }
}

createInitialAdmin();
