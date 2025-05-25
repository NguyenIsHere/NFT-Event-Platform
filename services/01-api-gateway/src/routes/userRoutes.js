const express = require('express')
const userController = require('../controllers/userController')
const authMiddleware = require('../middleware/authMiddleware') // Import middleware
const router = express.Router()

// Áp dụng middleware verifyToken cho tất cả các route trong file này
// Hoặc bạn có thể áp dụng cho từng route cụ thể
router.use(authMiddleware.verifyToken)

router.get('/:userId', userController.getUserById)
// Các route khác cần xác thực
module.exports = router
