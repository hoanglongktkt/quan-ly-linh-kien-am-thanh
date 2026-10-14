#!/usr/bin/env node

/**
 * Security Setup Quick Start
 * Run: node scripts/security-setup.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.join(__dirname, '..');

console.log('🔒 Security Setup Quick Start');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Step 1: Check if dependencies are installed
console.log('Step 1: Checking dependencies...');
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const requiredDeps = ['express-rate-limit', 'bcrypt', 'zod'];
const missing = requiredDeps.filter(dep => !packageJson.dependencies[dep] && !packageJson.devDependencies[dep]);

if (missing.length > 0) {
  console.log('❌ Missing dependencies:', missing.join(', '));
  console.log('\n👉 Please run: npm install express-rate-limit bcrypt zod\n');
  process.exit(1);
}
console.log('✅ All dependencies installed\n');

// Step 2: Generate secrets
console.log('Step 2: Generating strong secrets...');
const jwtSecret = crypto.randomBytes(64).toString('base64');
const adminPassword = crypto.randomBytes(32).toString('hex');

console.log('\n🔑 Generated Secrets (SAVE THESE SECURELY):');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('JWT_SECRET=');
console.log(jwtSecret);
console.log('\nADMIN_PASSWORD=');
console.log(adminPassword);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

// Step 3: Check .env file
console.log('Step 3: Checking environment configuration...');
const envPath = path.join(rootDir, '.env');
const envLocalPath = path.join(rootDir, '.env.local');

let envFile = envPath;
if (fs.existsSync(envLocalPath)) {
  envFile = envLocalPath;
}

if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf8');

  const warnings = [];

  if (envContent.includes('password123')) {
    warnings.push('⚠️  Default ADMIN_PASSWORD detected');
  }

  if (envContent.includes('your_jwt_secret_key_change_me_in_production')) {
    warnings.push('⚠️  Default JWT_SECRET detected');
  }

  if (warnings.length > 0) {
    console.log('❌ Security issues found in .env:');
    warnings.forEach(w => console.log('  ' + w));
    console.log('\n👉 Update your .env file with the generated secrets above\n');
  } else {
    console.log('✅ .env configuration looks good\n');
  }
} else {
  console.log('⚠️  No .env file found');
  console.log('👉 Create .env from .env.example and add the secrets above\n');
}

// Step 4: Instructions
console.log('📋 Next Steps:');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('1. Update .env with generated secrets');
console.log('2. Update Vercel environment variables:');
console.log('   - JWT_SECRET (same as .env)');
console.log('   - ADMIN_PASSWORD (same as .env)');
console.log('3. Update cPanel environment variables (same values)');
console.log('4. Create initial admin user:');
console.log('   node scripts/create-initial-admin.mjs');
console.log('5. Review SERVER_SECURITY_PATCH.js for server.ts updates');
console.log('6. Test login with new credentials');
console.log('7. Read SECURITY_IMPLEMENTATION.md for full guide');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

console.log('⚠️  IMPORTANT:');
console.log('- JWT_SECRET must be IDENTICAL on Vercel and cPanel');
console.log('- Save generated secrets securely (password manager)');
console.log('- Never commit .env files to git');
console.log('- Change secrets immediately if compromised\n');

console.log('✅ Security setup checklist created!');
console.log('📄 See SECURITY_IMPLEMENTATION.md for detailed instructions\n');
