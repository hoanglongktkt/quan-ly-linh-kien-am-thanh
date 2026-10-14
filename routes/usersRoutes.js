/**
 * User Management Routes - RBAC Administration
 */
import express from 'express';
import { authMiddleware } from '../middlewares/auth.js';
import { requireAdmin } from '../middlewares/rbac.js';
import { loginLimiter } from '../middlewares/rateLimiter.js';
import {
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  unlockUser,
  resetUserPassword
} from '../controllers/usersController.js';

const router = express.Router();

// All user management endpoints require admin role
router.use(authMiddleware);
router.use(requireAdmin);

// List all users
router.get('/', listUsers);

// Create new user
router.post('/', createUser);

// Update user
router.patch('/:id', updateUser);

// Delete user
router.delete('/:id', deleteUser);

// Unlock locked account
router.post('/:id/unlock', unlockUser);

// Admin reset user password
router.post('/:id/reset-password', resetUserPassword);

export default router;
