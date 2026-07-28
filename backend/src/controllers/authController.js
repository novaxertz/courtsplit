const jwt = require('jsonwebtoken');
const User = require('../models/User');
const config = require('../config/env');
const ApiError = require('../utils/ApiError');
const asyncHandler = require('../utils/asyncHandler');

function issueToken(user) {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role },
    config.jwt.secret,
    { expiresIn: config.jwt.expiresIn }
  );
}

const register = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password) {
    throw ApiError.badRequest('name, email and password are required');
  }
  if (password.length < 8) {
    throw ApiError.badRequest('Password must be at least 8 characters');
  }

  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    throw ApiError.conflict('That email is already registered');
  }

  const user = await User.create({
    name,
    email,
    passwordHash: await User.hashPassword(password),
    role: role === 'venue' ? 'venue' : 'player'
  });

  res.status(201).json({ user, token: issueToken(user) });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    throw ApiError.badRequest('email and password are required');
  }

  const user = await User.findOne({ email: email.toLowerCase() });
  // Same message whether the email is unknown or the password is wrong, so the
  // endpoint cannot be used to discover which addresses are registered.
  if (!user || !(await user.verifyPassword(password))) {
    throw ApiError.unauthorized('Invalid email or password');
  }

  res.json({ user, token: issueToken(user) });
});

const me = asyncHandler(async (req, res) => {
  const user = await User.findById(req.user.id);
  if (!user) throw ApiError.notFound('User not found');
  res.json({ user });
});

module.exports = { register, login, me };
