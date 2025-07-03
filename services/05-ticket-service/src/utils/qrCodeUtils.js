// 05-ticket-service/src/utils/qrCodeUtils.js

const QRCode = require('qrcode')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const ethers = require('ethers')

/**
 * Tạo QR code data cho ticket
 * @param {Object} ticketData - Thông tin ticket
 * @returns {Object} QR code data và secret
 */
function generateQRCodeData (ticketData) {
  const qrCodeId = uuidv4()
  const secret = crypto.randomBytes(32).toString('hex')

  // Tạo signature để verify tính hợp lệ của QR code
  const dataToSign = `${ticketData.ticketId}:${ticketData.eventId}:${ticketData.ownerAddress}:${qrCodeId}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex')

  const qrCodeData = {
    id: qrCodeId,
    ticketId: ticketData.ticketId,
    eventId: ticketData.eventId,
    ownerAddress: ticketData.ownerAddress,
    signature: signature,
    timestamp: Date.now()
  }

  return {
    qrCodeData: JSON.stringify(qrCodeData),
    qrCodeSecret: secret
  }
}

/**
 * Verify QR code data
 * @param {string} qrCodeDataString - QR code data string
 * @param {string} secret - Secret key
 * @returns {Object} Verification result
 */
function verifyQRCodeData (qrCodeDataString, secret) {
  try {
    const qrData = JSON.parse(qrCodeDataString)

    // Tạo lại signature để verify
    const dataToSign = `${qrData.ticketId}:${qrData.eventId}:${qrData.ownerAddress}:${qrData.id}`
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex')

    if (qrData.signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid signature' }
    }

    // Check timestamp (QR code có thể có thời gian hết hạn)
    const maxAge = 24 * 7 * 60 * 60 * 1000 // 24 hours
    if (Date.now() - qrData.timestamp > maxAge) {
      return { valid: false, reason: 'QR code expired' }
    }

    return { valid: true, data: qrData }
  } catch (error) {
    return { valid: false, reason: 'Invalid QR code format' }
  }
}

/**
 * Generate QR code image
 * @param {string} data - Data to encode
 * @returns {Promise<string>} Base64 encoded QR code image
 */
// async function generateQRCodeImage (data) {
//   try {
//     const qrCodeDataURL = await QRCode.toDataURL(data, {
//       type: 'image/png',
//       quality: 0.92,
//       margin: 1,
//       color: {
//         dark: '#000000',
//         light: '#FFFFFF'
//       },
//       width: 256
//     })
//     return qrCodeDataURL
//   } catch (error) {
//     throw new Error(`Failed to generate QR code image: ${error.message}`)
//   }
// }

/**
 * Generate QR code image from secure QR data
 * @param {string} secureQrDataString - JSON string of secure QR data
 * @returns {Promise<string>} Base64 encoded QR code image with data:image/png;base64, prefix
 */
async function generateQRCodeImage (secureQrDataString) {
  try {
    // ✅ VALIDATE: Input should be secure QR JSON string
    let qrData
    try {
      qrData = JSON.parse(secureQrDataString)
    } catch (parseError) {
      throw new Error('Input must be valid JSON string for secure QR data')
    }

    // ✅ VALIDATE: Must be secure QR type
    if (qrData.type !== 'SECURE_CHECKIN_V1') {
      throw new Error(
        'Only secure QR codes with type SECURE_CHECKIN_V1 are supported'
      )
    }

    // ✅ VALIDATE: Required fields for secure QR
    const requiredFields = [
      'address',
      'message',
      'signature',
      'ticketId',
      'eventId',
      'timestamp'
    ]
    for (const field of requiredFields) {
      if (!qrData[field]) {
        throw new Error(`Missing required field for secure QR: ${field}`)
      }
    }

    console.log('🔐 Generating QR image for secure data with signature')

    // ✅ GENERATE: QR code image with optimized settings for secure data
    const qrCodeDataURL = await QRCode.toDataURL(secureQrDataString, {
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256,
      errorCorrectionLevel: 'M' // Medium error correction for better compatibility
    })

    console.log('✅ Secure QR image generated successfully')
    return qrCodeDataURL
  } catch (error) {
    console.error('❌ Failed to generate secure QR code image:', error)
    throw new Error(`Failed to generate QR code image: ${error.message}`)
  }
}

/**
 * Verify secure QR data with digital signature
 * @param {string} qrCodeDataString - JSON string of QR data
 * @returns {Object} Verification result with detailed info
 */
function verifySecureQRData (qrCodeDataString) {
  try {
    console.log('🔍 Starting secure QR verification')

    // ✅ PARSE: QR data
    let qrData
    try {
      qrData = JSON.parse(qrCodeDataString)
    } catch (parseError) {
      return {
        valid: false,
        reason: 'Invalid QR code format: not valid JSON',
        errorType: 'PARSE_ERROR'
      }
    }

    // ✅ VALIDATE: Must be secure QR type
    if (qrData.type !== 'SECURE_CHECKIN_V1') {
      return {
        valid: false,
        reason: 'Only secure QR codes with digital signatures are supported',
        errorType: 'INVALID_TYPE',
        actualType: qrData.type
      }
    }

    // ✅ VALIDATE: Required fields
    const requiredFields = [
      'address',
      'message',
      'signature',
      'ticketId',
      'eventId',
      'timestamp'
    ]
    const missingFields = requiredFields.filter(field => !qrData[field])

    if (missingFields.length > 0) {
      return {
        valid: false,
        reason: `Missing required fields: ${missingFields.join(', ')}`,
        errorType: 'MISSING_FIELDS',
        missingFields: missingFields
      }
    }

    // ✅ CHECK: Timestamp freshness (24 hours max age)
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours
    const qrAge = Date.now() - qrData.timestamp

    if (qrAge > maxAge) {
      const ageHours = qrAge / (1000 * 60 * 60)
      return {
        valid: false,
        reason: `QR code expired: ${ageHours.toFixed(
          1
        )} hours old (max 24 hours)`,
        errorType: 'EXPIRED',
        ageHours: ageHours
      }
    }

    // ✅ VERIFY: Digital signature
    let recoveredAddress
    try {
      recoveredAddress = ethers.verifyMessage(qrData.message, qrData.signature)
    } catch (signatureError) {
      return {
        valid: false,
        reason: 'Invalid digital signature format or verification failed',
        errorType: 'SIGNATURE_ERROR',
        error: signatureError.message
      }
    }

    // ✅ CHECK: Signature consistency
    if (recoveredAddress.toLowerCase() !== qrData.address.toLowerCase()) {
      return {
        valid: false,
        reason:
          'Signature verification failed: recovered address does not match claimed address',
        errorType: 'ADDRESS_MISMATCH',
        claimedAddress: qrData.address,
        recoveredAddress: recoveredAddress
      }
    }

    console.log('✅ Secure QR verification successful')

    return {
      valid: true,
      data: qrData,
      verificationInfo: {
        signatureVerified: true,
        addressMatches: true,
        ageHours: qrAge / (1000 * 60 * 60),
        recoveredAddress: recoveredAddress
      }
    }
  } catch (error) {
    console.error('❌ Secure QR verification error:', error)
    return {
      valid: false,
      reason: `Verification failed: ${error.message}`,
      errorType: 'VERIFICATION_ERROR'
    }
  }
}

/**
 * Extract basic info from secure QR data without full verification
 * Useful for quick checks or displaying QR info
 * @param {string} qrCodeDataString - JSON string of QR data
 * @returns {Object} Basic QR info or null if invalid
 */
function extractSecureQRInfo (qrCodeDataString) {
  try {
    const qrData = JSON.parse(qrCodeDataString)

    if (qrData.type !== 'SECURE_CHECKIN_V1') {
      return null
    }

    return {
      type: qrData.type,
      ticketId: qrData.ticketId,
      eventId: qrData.eventId,
      signerAddress: qrData.address,
      timestamp: qrData.timestamp,
      age: Date.now() - qrData.timestamp,
      hasSignature: !!qrData.signature,
      hasMessage: !!qrData.message
    }
  } catch (error) {
    console.warn('Failed to extract QR info:', error.message)
    return null
  }
}

/**
 * Create secure QR data structure (helper for frontend)
 * @param {Object} qrInfo - QR information
 * @returns {string} JSON string of secure QR data
 */
function createSecureQRData (qrInfo) {
  const { address, message, signature, ticketId, eventId, timestamp, nonce } =
    qrInfo

  // ✅ VALIDATE: Required fields
  if (
    !address ||
    !message ||
    !signature ||
    !ticketId ||
    !eventId ||
    !timestamp
  ) {
    throw new Error('Missing required fields for secure QR creation')
  }

  const secureQrData = {
    address: address.toLowerCase(),
    message: message,
    signature: signature,
    ticketId: ticketId,
    eventId: eventId,
    timestamp: timestamp,
    nonce: nonce || Math.random().toString(36).substring(2, 15),
    type: 'SECURE_CHECKIN_V1'
  }

  return JSON.stringify(secureQrData)
}

// ✅ LEGACY: Keep for backward compatibility with old tickets (but log warnings)
/**
 * @deprecated Use verifySecureQRData instead. This function is kept for backward compatibility only.
 */
function verifyQRCodeData (qrCodeDataString, secret) {
  console.warn(
    '⚠️ DEPRECATED: verifyQRCodeData called. Please use verifySecureQRData for new QR codes.'
  )

  try {
    const qrData = JSON.parse(qrCodeDataString)

    // If it's a secure QR, redirect to new function
    if (qrData.type === 'SECURE_CHECKIN_V1') {
      console.log('🔄 Redirecting secure QR to new verification method')
      return verifySecureQRData(qrCodeDataString)
    }

    // Legacy verification logic for old QR codes (if any exist)
    console.warn(
      '⚠️ Processing legacy QR code - please regenerate with secure method'
    )

    const crypto = require('crypto')
    const dataToSign = `${qrData.ticketId}:${qrData.eventId}:${qrData.ownerAddress}:${qrData.id}`
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(dataToSign)
      .digest('hex')

    if (qrData.signature !== expectedSignature) {
      return { valid: false, reason: 'Invalid legacy signature' }
    }

    const maxAge = 24 * 7 * 60 * 60 * 1000 // 7 days for legacy
    if (Date.now() - qrData.timestamp > maxAge) {
      return { valid: false, reason: 'Legacy QR code expired' }
    }

    return { valid: true, data: qrData, legacy: true }
  } catch (error) {
    return { valid: false, reason: 'Invalid legacy QR code format' }
  }
}

/**
 * @deprecated Use createSecureQRData instead. This function is kept for backward compatibility only.
 */
function generateQRCodeData (ticketData) {
  console.warn(
    '⚠️ DEPRECATED: generateQRCodeData called. Please use createSecureQRData for new QR codes.'
  )

  const crypto = require('crypto')
  const { v4: uuidv4 } = require('uuid')

  const qrCodeId = uuidv4()
  const secret = crypto.randomBytes(32).toString('hex')

  const dataToSign = `${ticketData.ticketId}:${ticketData.eventId}:${ticketData.ownerAddress}:${qrCodeId}`
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('hex')

  const qrCodeData = {
    id: qrCodeId,
    ticketId: ticketData.ticketId,
    eventId: ticketData.eventId,
    ownerAddress: ticketData.ownerAddress,
    signature: signature,
    timestamp: Date.now(),
    type: 'LEGACY_QR' // Mark as legacy
  }

  return {
    qrCodeData: JSON.stringify(qrCodeData),
    qrCodeSecret: secret
  }
}

module.exports = {
  // ✅ NEW: Primary functions for secure QR
  generateQRCodeImage,
  verifySecureQRData,
  extractSecureQRInfo,
  createSecureQRData,

  // ✅ DEPRECATED: Legacy functions for backward compatibility
  verifyQRCodeData,
  generateQRCodeData
}
