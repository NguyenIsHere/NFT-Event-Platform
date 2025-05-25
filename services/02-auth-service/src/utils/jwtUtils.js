const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
const ACCESS_TOKEN_EXPIRATION = process.env.JWT_ACCESS_TOKEN_EXPIRATION || '15m'
const REFRESH_TOKEN_EXPIRATION_MS = convertToMillis(
  process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d'
)

function convertToMillis (timeStr) {
  if (typeof timeStr === 'number') return timeStr
  const unit = timeStr.slice(-1)
  const value = parseInt(timeStr.slice(0, -1))
  switch (unit) {
    case 's':
      return value * 1000
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
    default:
      return parseInt(timeStr) // Giả sử là ms nếu không có đơn vị
  }
}

function generateAccessToken (userId, roles = []) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined')
  return jwt.sign({ userId, roles }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRATION
  })
}

function generateRefreshToken (userId, roles = []) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined')
  // Refresh token thường có thời gian sống dài hơn và không chứa nhiều thông tin nhạy cảm
  // nhưng vẫn có thể chứa userId để dễ dàng tra cứu khi refresh
  return jwt.sign(
    { userId, roles, type: 'refresh' }, // Thêm type để phân biệt
    JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_TOKEN_EXPIRATION || '7d' } // Phải khớp với schema expiry
  )
}

function verifyToken (token) {
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not defined')
  try {
    return jwt.verify(token, JWT_SECRET)
  } catch (error) {
    // console.error('Invalid token:', error.message);
    return null // Hoặc throw lỗi tùy theo cách xử lý
  }
}

function getRefreshTokenExpiryDate () {
  return new Date(Date.now() + REFRESH_TOKEN_EXPIRATION_MS)
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  getRefreshTokenExpiryDate,
  JWT_REFRESH_TOKEN_EXPIRATION_MS
}
