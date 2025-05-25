const { userServiceClient } = require('../clients')
const grpc = require('@grpc/grpc-js')

exports.getUserById = async (req, res) => {
  const { userId } = req.params
  try {
    userServiceClient.GetUserById({ user_id: userId }, (error, response) => {
      if (error) {
        console.error(
          'GetUserById gRPC call error:',
          error.details || error.message
        )
        return res
          .status(error.code === grpc.status.NOT_FOUND ? 404 : 500)
          .json({
            message: error.details || 'Failed to get user',
            code: error.code
          })
      }
      res.status(200).json(response)
    })
  } catch (err) {
    console.error('API GetUserById Error:', err)
    res.status(500).json({ message: 'Internal server error' })
  }
}

// Thêm các controller khác cho UserService nếu cần
// Ví dụ: getUserByEmail, getUserByWalletAddress
// Lưu ý: CreateUser thường được gọi qua authController.registerUser
