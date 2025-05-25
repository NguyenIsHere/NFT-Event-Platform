require('dotenv').config() // Nạp .env ở thư mục gốc của service này
const express = require('express')
const cors = require('cors')
const helmet = require('helmet')
const morgan = require('morgan')
const Consul = require('consul')

const mainRouter = require('./routes') // Import router chính

const PORT = process.env.PORT || 3000
const CONSUL_AGENT_HOST = process.env.CONSUL_AGENT_HOST || 'consul'
const SERVICE_NAME = 'api-gateway-service' // Tên service này để đăng ký với Consul
const SERVICE_ADDRESS = process.env.HOSTNAME || 'api-gateway-service' // Tên host của container này

const app = express()

// Middleware
app.use(cors()) // Cho phép Cross-Origin Resource Sharing
app.use(helmet()) // Bảo mật cơ bản với các HTTP headers
app.use(express.json()) // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })) // Parse URL-encoded request bodies
if (process.env.NODE_ENV === 'development') {
  app.use(morgan('dev')) // Logging HTTP request cho dev
}

// Routes
app.use('/api', mainRouter) // Tất cả API sẽ có prefix /api

// Xử lý lỗi 404 chung
app.use((req, res, next) => {
  res.status(404).json({ message: 'Not Found' })
})

// Xử lý lỗi chung
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).json({ message: 'Internal Server Error', error: err.message })
})

app.listen(PORT, () => {
  console.log(
    `${SERVICE_NAME} (Node.js REST Gateway) is running on port ${PORT}`
  )

  // Đăng ký với Consul
  const consul = new Consul({ host: CONSUL_AGENT_HOST, promisify: true })
  const serviceId = `${SERVICE_NAME}-${SERVICE_ADDRESS}-${PORT}`

  const check = {
    name: `HTTP health check for ${SERVICE_NAME}`,
    http: `http://${SERVICE_ADDRESS}:${PORT}/api/health`, // Endpoint health check
    interval: '10s',
    timeout: '5s',
    deregistercriticalserviceafter: '1m'
  }

  consul.agent.service
    .register({
      name: SERVICE_NAME,
      id: serviceId,
      address: SERVICE_ADDRESS, // Consul sẽ phân giải tên này trong Docker network
      port: parseInt(PORT),
      tags: ['http', 'rest', 'nodejs', 'gateway'],
      check: check
    })
    .then(() => {
      console.log(
        `Service ${SERVICE_NAME} (ID: ${serviceId}) registered with Consul`
      )
    })
    .catch(err => {
      console.error(`Failed to register ${SERVICE_NAME} with Consul:`, err)
    })

  // Xử lý khi service tắt (ví dụ Ctrl+C) để hủy đăng ký khỏi Consul
  process.on('SIGINT', () => {
    console.log(`Deregistering ${serviceId} from Consul...`)
    consul.agent.service.deregister(serviceId).finally(() => {
      console.log(`${serviceId} deregistered.`)
      process.exit(0)
    })
  })
})
