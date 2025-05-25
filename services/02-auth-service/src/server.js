require('dotenv').config()
const path = require('path')
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const mongoose = require('mongoose')
const authServiceHandlers = require('./handlers/authServiceHandlers')

const PORT = process.env.PORT || 50050
const MONGO_URI = process.env.MONGO_URI
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'

// Đường dẫn tới file auth.proto
const AUTH_PROTO_PATH = path.resolve(process.cwd(), 'protos', 'auth.proto')

const packageDefinition = protoLoader.loadSync(AUTH_PROTO_PATH, {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true
})
const authProto = grpc.loadPackageDefinition(packageDefinition).auth // 'auth' là package name trong auth.proto

async function main () {
  if (!MONGO_URI) {
    console.error('FATAL ERROR: MONGO_URI is not defined for auth-service.')
    process.exit(1)
  }
  if (!process.env.JWT_SECRET) {
    console.error('FATAL ERROR: JWT_SECRET is not defined.')
    process.exit(1)
  }

  try {
    await mongoose.connect(MONGO_URI)
    console.log('MongoDB connected successfully to auth-service')
  } catch (err) {
    console.error('MongoDB connection error for auth-service:', err)
    process.exit(1)
  }

  const server = new grpc.Server()
  server.addService(authProto.AuthService.service, authServiceHandlers)

  server.bindAsync(
    `0.0.0.0:${PORT}`,
    grpc.ServerCredentials.createInsecure(),
    (err, port) => {
      if (err) {
        console.error('Failed to bind server:', err)
        return
      }
      console.log(`Auth gRPC Service running on port ${port}`)
      server.start()

      // TODO: Implement Consul registration logic here (tương tự User Service)
      // const consul = require('consul')({ host: CONSUL_AGENT_HOST });
      // const serviceName = 'auth-service';
      // ... (logic đăng ký)
    }
  )
}

main()
