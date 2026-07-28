const express = require('express');
const authenticate = require('../middleware/auth');
const authController = require('../controllers/authController');
const courtController = require('../controllers/courtController');
const bookingController = require('../controllers/bookingController');

const router = express.Router();

router.post('/auth/register', authController.register);
router.post('/auth/login', authController.login);
router.get('/auth/me', authenticate, authController.me);

router.get('/courts', courtController.list);
router.post('/courts', authenticate, courtController.create);
router.get('/courts/:id/availability', courtController.availability);

router.post('/bookings', authenticate, bookingController.create);
router.get('/bookings', authenticate, bookingController.listMine);
router.get('/bookings/:id', authenticate, bookingController.getOne);
router.post('/bookings/:id/cancel', authenticate, bookingController.cancel);

module.exports = router;
