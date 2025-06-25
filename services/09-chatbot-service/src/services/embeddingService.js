const axios = require('axios')

// Sử dụng Google Embedding API hoặc local model
const EMBEDDING_API_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/embedding-001:embedContent'
const GEMINI_API_KEY = process.env.GEMINI_API_KEY

async function generateEmbedding (text) {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty')
    }

    // Sử dụng Google Embedding API
    const response = await axios.post(
      `${EMBEDDING_API_URL}?key=${GEMINI_API_KEY}`,
      {
        model: 'models/embedding-001',
        content: {
          parts: [
            {
              text: text
            }
          ]
        }
      },
      {
        headers: {
          'Content-Type': 'application/json'
        },
        timeout: 10000
      }
    )

    if (response.data?.embedding?.values) {
      return response.data.embedding.values
    } else {
      throw new Error('Invalid embedding response')
    }
  } catch (error) {
    console.error(
      'Error generating embedding:',
      error.response?.data || error.message
    )

    // Fallback: tạo dummy embedding (trong production nên dùng model khác)
    console.warn('Using fallback embedding generation')
    return generateDummyEmbedding(text)
  }
}

// Fallback embedding generator (simple hash-based)
function generateDummyEmbedding (text, dimension = 768) {
  const embedding = new Array(dimension).fill(0)

  // Simple hash-based embedding generation
  for (let i = 0; i < text.length; i++) {
    const charCode = text.charCodeAt(i)
    const index = charCode % dimension
    embedding[index] += Math.sin(charCode * 0.1)
  }

  // Normalize vector
  const magnitude = Math.sqrt(
    embedding.reduce((sum, val) => sum + val * val, 0)
  )
  return embedding.map(val => (magnitude > 0 ? val / magnitude : 0))
}

async function generateBatchEmbeddings (texts) {
  const embeddings = []

  // Process in batches to avoid rate limits
  const batchSize = 5
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    const batchPromises = batch.map(text => generateEmbedding(text))

    try {
      const batchResults = await Promise.all(batchPromises)
      embeddings.push(...batchResults)

      // Rate limiting
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 100))
      }
    } catch (error) {
      console.error(`Error processing batch ${i}-${i + batchSize}:`, error)
      // Add dummy embeddings for failed batch
      batch.forEach(() => embeddings.push(generateDummyEmbedding('fallback')))
    }
  }

  return embeddings
}

module.exports = {
  generateEmbedding,
  generateBatchEmbeddings
}
