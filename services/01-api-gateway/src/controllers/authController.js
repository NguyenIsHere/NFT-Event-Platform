const { authServiceClient } = require('../clients') // Import gRPC client
const grpc = require('@grpc/grpc-js')

exports.registerUser = async (req, res) => {
  const { full_name, email, password, role } = req.body
  try {
    authServiceClient.Register(
      { full_name, email, password, role },
      (error, response) => {
        if (error) {
          console.error(
            'Register gRPC call error:',
            error.details || error.message
          )
          return res
            .status(
              error.code === grpc.status.ALREADY_EXISTS
                ? 409
                : error.code === grpc.status.INVALID_ARGUMENT
                ? 400
                : 500
            )
            .json({
              message: error.details || 'Failed to register user',
              code: error.code
            })
        }
        res.status(201).json(response)
      }
    )
  } catch (err) {
    console.error('API Register Error:', err)
    res.status(500).json({ message: 'Internal server error' })
  }
}

exports.loginUser = async (req, res) => {
  const { email, password } = req.body
  try {
    authServiceClient.Login({ email, password }, (error, response) => {
      if (error) {
        console.error('Login gRPC call error:', error.details || error.message)
        return res
          .status(error.code === grpc.status.UNAUTHENTICATED ? 401 : 500)
          .json({
            message: error.details || 'Login failed',
            code: error.code
          })
      }
      res.status(200).json(response)
    })
  } catch (err) {
    console.error('API Login Error:', err)
    res.status(500).json({ message: 'Internal server error' })
  }
}

exports.refreshToken = async (req, res) => {
  const { refresh_token } = req.body
  if (!refresh_token) {
    return res.status(400).json({ message: 'Refresh token is required' })
  }
  try {
    authServiceClient.RefreshToken({ refresh_token }, (error, response) => {
      if (error) {
        console.error(
          'RefreshToken gRPC call error:',
          error.details || error.message
        )
        return res
          .status(error.code === grpc.status.UNAUTHENTICATED ? 401 : 500)
          .json({
            message: error.details || 'Failed to refresh token',
            code: error.code
          })
      }
      res.status(200).json(response)
    })
  } catch (err) {
    console.error('API RefreshToken Error:', err)
    res.status(500).json({ message: 'Internal server error' })
  }
}
