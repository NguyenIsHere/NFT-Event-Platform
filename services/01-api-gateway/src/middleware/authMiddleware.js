// services/01-api-gateway/src/middleware/authMiddleware.js
const jwt = require('jsonwebtoken')
const JWT_SECRET = process.env.JWT_SECRET

exports.verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7, authHeader.length) // Lấy token từ "Bearer <token>"

    if (!JWT_SECRET) {
      console.error(
        'FATAL ERROR: JWT_SECRET is not defined in api-gateway .env'
      )
      return res
        .status(500)
        .json({ message: 'Internal server configuration error' })
    }

    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) {
        // Token không hợp lệ (hết hạn, sai chữ ký, etc.)
        return res
          .status(401)
          .json({ message: 'Unauthorized: Invalid or expired token' })
      }
      // Token hợp lệ, gắn thông tin user đã giải mã vào request
      // để các controller sau có thể sử dụng nếu cần
      req.user = decoded // decoded sẽ chứa { userId, roles } hoặc bất cứ gì bạn đặt trong payload khi tạo token
      next() // Tiếp tục xử lý request
    })
  } else {
    // Không có token hoặc header không đúng định dạng
    res
      .status(401)
      .json({
        message: 'Unauthorized: Missing or invalid authorization header'
      })
  }
}
