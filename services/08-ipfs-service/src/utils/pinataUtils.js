// src/utils/pinataUtils.js
require('dotenv').config({
  path: require('path').resolve(__dirname, '..', '..', '.env')
}) // Load .env từ thư mục gốc của service
const axios = require('axios')
const FormData = require('form-data')

const PINATA_JWT = process.env.PINATA_JWT
const PINATA_BASE_URL = 'https://api.pinata.cloud'

/**
 * Pin file content to IPFS via Pinata.
 * @param {Buffer} fileContentBuffer - Buffer of the file content.
 * @param {string} [originalFileName] - Optional original name of the file.
 * @param {object} [pinataAPIOptions] - Optional: { name: 'custom pin name', keyvalues: { customKey: 'customValue' } }
 * @returns {Promise<object>} Pinata API response { IpfsHash, PinSize, Timestamp }
 */
async function pinFileToIPFS (
  fileContentBuffer,
  originalFileName,
  pinataAPIOptions
) {
  if (!PINATA_JWT) {
    throw new Error('Pinata JWT is not configured.')
  }

  const url = `${PINATA_BASE_URL}/pinning/pinFileToIPFS`
  const data = new FormData()
  data.append(
    'file',
    fileContentBuffer,
    originalFileName || 'uploaded_file_from_service'
  )

  const optionsPayload = {}
  if (pinataAPIOptions && pinataAPIOptions.name) {
    // Pinata's pinFileToIPFS expects pinataMetadata to contain name and keyvalues
    if (!optionsPayload.pinataMetadata) optionsPayload.pinataMetadata = {}
    optionsPayload.pinataMetadata.name = pinataAPIOptions.name
  }
  if (pinataAPIOptions && pinataAPIOptions.keyvalues) {
    if (!optionsPayload.pinataMetadata) optionsPayload.pinataMetadata = {}
    optionsPayload.pinataMetadata.keyvalues = pinataAPIOptions.keyvalues
  }
  // You can also add 'pinataOptions' for cidVersion etc. if needed
  // if (pinataAPIOptions && pinataAPIOptions.cidVersion) {
  //   optionsPayload.pinataOptions = { cidVersion: pinataAPIOptions.cidVersion };
  // }

  if (Object.keys(optionsPayload).length > 0) {
    if (optionsPayload.pinataMetadata) {
      data.append(
        'pinataMetadata',
        JSON.stringify(optionsPayload.pinataMetadata)
      )
    }
    // if (optionsPayload.pinataOptions) { // If you add other options like cidVersion
    //    data.append('pinataOptions', JSON.stringify(optionsPayload.pinataOptions));
    // }
  }

  try {
    const response = await axios.post(url, data, {
      maxBodyLength: Infinity,
      headers: {
        ...data.getHeaders(), // Correctly get headers from FormData instance
        Authorization: `Bearer ${PINATA_JWT}`
      }
    })
    return response.data
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message
    console.error(
      'Error pinning file to Pinata:',
      errorMsg,
      error.response?.data
    )
    throw new Error(`Failed to pin file to Pinata: ${errorMsg}`)
  }
}

/**
 * Pin JSON object to IPFS via Pinata.
 * @param {object} jsonContent - The JSON object to pin.
 * @param {object} [pinataAPIOptions] - Optional: { name: 'custom pin name', keyvalues: { customKey: 'customValue' } }
 * @returns {Promise<object>} Pinata API response { IpfsHash, PinSize, Timestamp }
 */
async function pinJSONToIPFS (jsonContent, pinataAPIOptions) {
  if (!PINATA_JWT) {
    throw new Error('Pinata JWT is not configured.')
  }

  const url = `${PINATA_BASE_URL}/pinning/pinJSONToIPFS`
  const payload = {
    pinataContent: jsonContent
  }

  if (pinataAPIOptions) {
    payload.pinataMetadata = {} // Initialize pinataMetadata
    if (pinataAPIOptions.name) {
      payload.pinataMetadata.name = pinataAPIOptions.name
    }
    if (pinataAPIOptions.keyvalues) {
      payload.pinataMetadata.keyvalues = pinataAPIOptions.keyvalues
    }
    // Example for pinataOptions if needed:
    // payload.pinataOptions = { cidVersion: 1 };
  }

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${PINATA_JWT}`
      }
    })
    return response.data
  } catch (error) {
    const errorMsg = error.response?.data?.error || error.message
    console.error(
      'Error pinning JSON to Pinata:',
      errorMsg,
      error.response?.data
    )
    throw new Error(`Failed to pin JSON to Pinata: ${errorMsg}`)
  }
}

module.exports = {
  pinFileToIPFS,
  pinJSONToIPFS
}
