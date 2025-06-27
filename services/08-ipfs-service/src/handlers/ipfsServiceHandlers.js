// src/handlers/ipfsServiceHandlers.js
const grpc = require('@grpc/grpc-js')
const { pinFileToIPFS, pinJSONToIPFS } = require('../utils/pinataUtils')

// Helper function to convert gRPC map to a simple object for Pinata keyvalues
function convertGrpcMapToObject (grpcMap) {
  if (!grpcMap || typeof grpcMap.get !== 'function') {
    // Simple check if it's a Map-like object from gRPC
    // If it's already an object (e.g. from JSON parsing if client sends it weirdly)
    if (
      typeof grpcMap === 'object' &&
      grpcMap !== null &&
      !Array.isArray(grpcMap)
    ) {
      return grpcMap
    }
    return undefined
  }
  const obj = {}
  // gRPC map iteration is different; this is a simplified assumption.
  // The actual map from proto might be an object if keepCase=true, or a Map instance.
  // For `map<string, string> key_values` loaded by protoLoader with keepCase:true, it becomes an object.
  // If it were a true JS Map, you'd use: for (const [key, value] of grpcMap.entries()) { obj[key] = value; }
  // Assuming call.request.options.key_values is already an object:
  if (grpcMap && typeof grpcMap === 'object') {
    for (const key in grpcMap) {
      if (Object.prototype.hasOwnProperty.call(grpcMap, key)) {
        obj[key] = grpcMap[key]
      }
    }
    return Object.keys(obj).length > 0 ? obj : undefined
  }
  return undefined
}

async function PinFileToIPFS (call, callback) {
  console.log(
    'PinFileToIPFS RPC called with filename:',
    call.request.original_file_name
  )
  try {
    const { file_content, original_file_name, options } = call.request

    if (!file_content || file_content.length === 0) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'File content cannot be empty.'
      })
    }

    // Kong gateway sẽ gửi trường 'bytes' dưới dạng một chuỗi base64.
    // Chúng ta cần chuyển nó thành Buffer nhị phân thực sự.
    let fileBuffer
    if (typeof file_content === 'string') {
      console.log('🔍 Received file_content as a base64 string. Decoding...')
      fileBuffer = Buffer.from(file_content, 'base64')
    } else if (Buffer.isBuffer(file_content)) {
      console.log('🔍 Received file_content as a Buffer. Using as is.')
      fileBuffer = file_content
    } else {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'Invalid file_content type. Expected base64 string or Buffer.'
      })
    }

    const pinataAPIOptions = {}
    if (options) {
      if (options.pin_name) {
        pinataAPIOptions.name = options.pin_name
      }
      if (options.key_values && Object.keys(options.key_values).length > 0) {
        pinataAPIOptions.keyvalues = options.key_values
      }
    }

    const pinataResponse = await pinFileToIPFS(
      fileBuffer,
      original_file_name,
      pinataAPIOptions
    )

    callback(null, {
      ipfs_hash: pinataResponse.IpfsHash,
      pin_size_bytes: parseInt(pinataResponse.PinSize, 10),
      timestamp: pinataResponse.Timestamp,
      gateway_url: `https://gateway.pinata.cloud/ipfs/${pinataResponse.IpfsHash}`
    })
  } catch (error) {
    console.error('PinFileToIPFS RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to pin file to IPFS.'
    })
  }
}

async function PinJSONToIPFS (call, callback) {
  console.log('PinJSONToIPFS RPC called')
  try {
    const { json_content, options } = call.request

    if (!json_content) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: 'JSON content cannot be empty.'
      })
    }

    let jsonObject
    try {
      jsonObject = JSON.parse(json_content)
    } catch (parseError) {
      return callback({
        code: grpc.status.INVALID_ARGUMENT,
        message: `Invalid JSON content provided: ${parseError.message}`
      })
    }

    const pinataAPIOptions = {}
    if (options) {
      if (options.pin_name) {
        pinataAPIOptions.name = options.pin_name
      }
      if (options.key_values && Object.keys(options.key_values).length > 0) {
        pinataAPIOptions.keyvalues = options.key_values
      }
    }

    const pinataResponse = await pinJSONToIPFS(jsonObject, pinataAPIOptions)

    callback(null, {
      ipfs_hash: pinataResponse.IpfsHash,
      pin_size_bytes: parseInt(pinataResponse.PinSize, 10),
      timestamp: pinataResponse.Timestamp,
      gateway_url: `https://gateway.pinata.cloud/ipfs/${pinataResponse.IpfsHash}`
    })
  } catch (error) {
    console.error('PinJSONToIPFS RPC error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to pin JSON to IPFS.'
    })
  }
}

module.exports = {
  PinFileToIPFS,
  PinJSONToIPFS
}
