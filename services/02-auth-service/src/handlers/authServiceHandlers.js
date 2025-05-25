const jwtUtils = require('../utils/jwtUtils')
const RefreshToken = require('../models/RefreshToken')
const userServiceClient = require('../clients/userServiceClient') // gRPC client để gọi UserService
const grpc = require('@grpc/grpc-js') // Import grpc

async function Login (call, callback) {
  const { email, password } = call.request
  try {
    // 1. Gọi UserService để xác thực user và lấy thông tin
    userServiceClient.AuthenticateUser(
      { email, password },
      async (err, userResponse) => {
        if (err) {
          console.error(
            'Error authenticating user via UserService:',
            err.details || err.message
          )
          // Chuyển đổi lỗi từ UserService sang lỗi của AuthService
          let statusCode = grpc.status.INTERNAL
          if (
            err.code === grpc.status.NOT_FOUND ||
            err.code === grpc.status.UNAUTHENTICATED
          ) {
            statusCode = grpc.status.UNAUTHENTICATED
          }
          return callback({
            code: statusCode,
            message: err.details || 'Login failed: Could not authenticate user'
          })
        }

        if (!userResponse || !userResponse.id) {
          return callback({
            code: grpc.status.UNAUTHENTICATED,
            message: 'Login failed: Invalid user response from UserService'
          })
        }

        // 2. Tạo Access Token và Refresh Token
        const accessToken = jwtUtils.generateAccessToken(
          userResponse.id,
          userResponse.role ? [userResponse.role] : ['USER']
        )
        const refreshTokenString = jwtUtils.generateRefreshToken(
          userResponse.id,
          userResponse.role ? [userResponse.role] : ['USER']
        )
        const refreshTokenExpiry = jwtUtils.getRefreshTokenExpiryDate()

        // 3. Lưu Refresh Token vào DB
        const newRefreshToken = new RefreshToken({
          token: refreshTokenString,
          userId: userResponse.id,
          expiryDate: refreshTokenExpiry
        })
        await newRefreshToken.save()

        callback(null, {
          access_token: accessToken,
          refresh_token: refreshTokenString
        })
      }
    )
  } catch (error) {
    console.error('Login Error in AuthService:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Internal server error during login'
    })
  }
}

async function Register (call, callback) {
  const { full_name, email, password, role } = call.request
  try {
    // 1. Gọi UserService để tạo user mới
    // Lưu ý: CreateUserRequest của UserService có thể cần nhiều trường hơn
    // AuthService.RegisterRequest chỉ có những trường cơ bản.
    const createUserRequest = {
      full_name,
      email,
      password,
      role: role || 'USER' // Mặc định là USER nếu không cung cấp
      // Các trường khác như wallet_address, phone_number, avatar_cid sẽ là default/empty
    }

    userServiceClient.CreateUser(
      createUserRequest,
      async (err, userResponse) => {
        if (err) {
          console.error(
            'Error creating user via UserService:',
            err.details || err.message
          )
          let statusCode = grpc.status.INTERNAL
          if (
            err.code === grpc.status.ALREADY_EXISTS ||
            err.code === grpc.status.INVALID_ARGUMENT
          ) {
            statusCode = err.code
          }
          return callback({
            code: statusCode,
            message: err.details || 'Registration failed: Could not create user'
          })
        }

        if (!userResponse || !userResponse.id) {
          return callback({
            code: grpc.status.INTERNAL,
            message:
              'Registration failed: Invalid user response from UserService'
          })
        }

        // 2. Tạo Access Token và Refresh Token
        const accessToken = jwtUtils.generateAccessToken(
          userResponse.id,
          userResponse.role ? [userResponse.role] : ['USER']
        )
        const refreshTokenString = jwtUtils.generateRefreshToken(
          userResponse.id,
          userResponse.role ? [userResponse.role] : ['USER']
        )
        const refreshTokenExpiry = jwtUtils.getRefreshTokenExpiryDate()

        // 3. Lưu Refresh Token vào DB
        const newRefreshToken = new RefreshToken({
          token: refreshTokenString,
          userId: userResponse.id,
          expiryDate: refreshTokenExpiry
        })
        await newRefreshToken.save()

        callback(null, {
          access_token: accessToken,
          refresh_token: refreshTokenString
          // có thể trả về user_id hoặc thông tin user nếu cần
        })
      }
    )
  } catch (error) {
    console.error('Register Error in AuthService:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: 'Internal server error during registration'
    })
  }
}

// Đổi tên hàm này
async function handleRefreshToken (call, callback) {
  // <<< SỬA TÊN HÀM Ở ĐÂY
  const { refresh_token } = call.request
  try {
    const storedToken = await RefreshToken.findOne({ token: refresh_token })

    if (!storedToken) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid refresh token'
      })
    }
    if (storedToken.expiryDate.getTime() < Date.now()) {
      await RefreshToken.deleteOne({ _id: storedToken._id })
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Refresh token expired'
      })
    }

    const decoded = jwtUtils.verifyToken(refresh_token)
    if (
      !decoded ||
      decoded.userId !== storedToken.userId ||
      decoded.type !== 'refresh'
    ) {
      return callback({
        code: grpc.status.UNAUTHENTICATED,
        message: 'Invalid refresh token data'
      })
    }

    const newAccessToken = jwtUtils.generateAccessToken(
      decoded.userId,
      decoded.roles
    )

    callback(null, {
      access_token: newAccessToken,
      refresh_token: refresh_token
    })
  } catch (error) {
    console.error('RefreshToken Handler Error:', error) // Sửa tên log cho nhất quán
    callback({ code: grpc.status.INTERNAL, message: 'Internal server error' })
  }
}

module.exports = {
  Login,
  RefreshToken: handleRefreshToken, // <<< SỬA Ở ĐÂY KHI EXPORT
  Register
}
