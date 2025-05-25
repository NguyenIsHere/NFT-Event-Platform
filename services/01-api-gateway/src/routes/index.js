const express = require('express')
const authRoutes = require('./authRoutes')
const userRoutes = require('./userRoutes')
// const eventRoutes = require('./eventRoutes'); // Khi bạn tạo
// const ticketRoutes = require('./ticketRoutes'); // Khi bạn tạo

const router = express.Router()

router.use('/auth', authRoutes)
router.use('/users', userRoutes)
// router.use('/events', eventRoutes);
// router.use('/tickets', ticketRoutes);

// Endpoint kiểm tra sức khỏe của gateway
router.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', message: 'API Gateway is running' })
})

module.exports = router
