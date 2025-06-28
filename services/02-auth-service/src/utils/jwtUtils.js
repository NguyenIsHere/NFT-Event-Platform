const jwt = require('jsonwebtoken')

const JWT_SECRET = process.env.JWT_SECRET
const ACCESS_TOKEN_EXPIRATION = process.env.JWT_ACCESS_TOKEN_EXPIRATION || '15m'

const JWT_REFRESH_TOKEN_EXPIRATION_MS = convertToMillis(
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

  console.log('🔍 Generating JWT with:', { userId, roles })

  const payload = {
    userId,
    roles: Array.isArray(roles) ? roles : [roles], // ✅ Ensure it's array
    role: Array.isArray(roles) ? roles[0] : roles, // ✅ Single role for compatibility
    type: 'access',
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 15 * 60, // 15 minutes
    iss: 'my-application'
  }

  console.log('🔍 JWT Payload:', payload)

  return jwt.sign(payload, JWT_SECRET, { algorithm: 'HS256' })
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
  return new Date(Date.now() + JWT_REFRESH_TOKEN_EXPIRATION_MS)
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyToken,
  getRefreshTokenExpiryDate,
  JWT_REFRESH_TOKEN_EXPIRATION_MS
}
