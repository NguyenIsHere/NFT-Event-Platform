function extractUserIdFromJWT (authorizationHeader) {
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return null
  }

  try {
    const token = authorizationHeader.substring(7)
    const parts = token.split('.')

    if (parts.length !== 3) {
      throw new Error('Invalid JWT format')
    }

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())

    // Try different field names that might contain user ID
    return (
      payload.userId || payload.user_id || payload.sub || payload.iss || null
    )
  } catch (error) {
    console.error('Error extracting user ID from JWT:', error.message)
    return null
  }
}

function extractUserIdFromMetadata (metadata) {
  if (!metadata || !metadata.get) {
    return null
  }

  // Get authorization header and decode JWT manually
  const authHeaders = metadata.get('authorization')
  if (authHeaders && authHeaders.length > 0) {
    return extractUserIdFromJWT(authHeaders[0])
  }

  return null
}

function extractUserRolesFromMetadata (metadata) {
  if (!metadata || !metadata.get) {
    return []
  }

  const authHeaders = metadata.get('authorization')
  if (authHeaders && authHeaders.length > 0) {
    try {
      const token = authHeaders[0].substring(7)
      const parts = token.split('.')
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString())
        return payload.roles || []
      }
    } catch (error) {
      console.error('Error extracting roles from JWT:', error.message)
    }
  }

  return []
}

module.exports = {
  extractUserIdFromJWT,
  extractUserIdFromMetadata,
  extractUserRolesFromMetadata
}
