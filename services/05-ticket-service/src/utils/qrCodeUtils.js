// 05-ticket-service/src/utils/qrCodeUtils.js

const QRCode = require('qrcode')
const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')

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
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours
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
async function generateQRCodeImage (data) {
  try {
    const qrCodeDataURL = await QRCode.toDataURL(data, {
      type: 'image/png',
      quality: 0.92,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      },
      width: 256
    })
    return qrCodeDataURL
  } catch (error) {
    throw new Error(`Failed to generate QR code image: ${error.message}`)
  }
}

module.exports = {
  generateQRCodeData,
  verifyQRCodeData,
  generateQRCodeImage
}
