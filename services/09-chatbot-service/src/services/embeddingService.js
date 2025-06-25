const { GoogleGenAI } = require('@google/genai')

const GEMINI_API_KEY = process.env.GEMINI_API_KEY

// Initialize GoogleGenAI client
let genAI = null

function initializeGenAI () {
  if (!genAI && GEMINI_API_KEY) {
    genAI = new GoogleGenAI({ apiKey: GEMINI_API_KEY })
    console.log('Google GenAI client initialized')
  }
  return genAI
}

async function generateEmbedding (text) {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty')
    }

    // Initialize GenAI client if not already done
    const ai = initializeGenAI()
    if (!ai) {
      throw new Error('Google GenAI client not initialized - missing API key')
    }

    console.log('Generating embedding with Google GenAI SDK...')

    // Sử dụng model mới nhất: text-embedding-004
    const response = await ai.models.embedContent({
      model: 'text-embedding-004', // Hoặc 'gemini-embedding-exp-03-07'
      contents: text,
      config: {
        taskType: 'SEMANTIC_SIMILARITY' // Phù hợp cho chatbot search
        // Có thể thêm các config khác:
        // outputDimensionality: 768 // Nếu muốn control dimension
      }
    })

    if (response?.embeddings?.[0]?.values) {
      const embedding = response.embeddings[0].values
      console.log(`Generated embedding with dimension: ${embedding.length}`)
      return embedding
    } else {
      throw new Error('Invalid embedding response structure')
    }
  } catch (error) {
    console.error('Error generating embedding with GenAI SDK:', error.message)

    // Fallback: tạo dummy embedding
    console.warn('Using fallback embedding generation')
    return generateDummyEmbedding(text, 768) // Default dimension
  }
}

// Alternative function using different models
async function generateEmbeddingWithModel (
  text,
  modelName = 'text-embedding-004'
) {
  try {
    if (!text || text.trim().length === 0) {
      throw new Error('Text cannot be empty')
    }

    const ai = initializeGenAI()
    if (!ai) {
      throw new Error('Google GenAI client not initialized')
    }

    console.log(`Generating embedding with model: ${modelName}`)

    const response = await ai.models.embedContent({
      model: modelName, // 'text-embedding-004', 'gemini-embedding-exp-03-07', 'embedding-001'
      contents: text,
      config: {
        taskType: 'SEMANTIC_SIMILARITY'
      }
    })

    if (response?.embeddings?.[0]?.values) {
      const embedding = response.embeddings[0].values
      console.log(
        `Generated embedding with dimension: ${embedding.length} using ${modelName}`
      )
      return embedding
    } else {
      throw new Error('Invalid embedding response structure')
    }
  } catch (error) {
    console.error(
      `Error generating embedding with ${modelName}:`,
      error.message
    )
    throw error
  }
}

// Fallback embedding generator
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

  console.log(
    `Generating embeddings for ${texts.length} texts using Google GenAI SDK...`
  )

  // Process in smaller batches để tránh rate limits
  const batchSize = 3 // Giảm batch size cho GenAI SDK

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize)
    console.log(
      `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
        texts.length / batchSize
      )}`
    )

    try {
      // Process batch sequentially để tránh rate limit
      for (const text of batch) {
        try {
          const embedding = await generateEmbedding(text)
          embeddings.push(embedding)

          // Small delay between requests
          await new Promise(resolve => setTimeout(resolve, 200)) // 200ms delay
        } catch (error) {
          console.error(
            `Error processing individual text in batch:`,
            error.message
          )
          // Add fallback embedding for failed text
          embeddings.push(generateDummyEmbedding('fallback', 768))
        }
      }

      console.log(
        `Completed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
          texts.length / batchSize
        )}`
      )

      // Larger delay between batches
      if (i + batchSize < texts.length) {
        await new Promise(resolve => setTimeout(resolve, 1000)) // 1 second delay
      }
    } catch (error) {
      console.error(
        `Error processing batch ${i}-${i + batchSize}:`,
        error.message
      )
      // Add dummy embeddings for entire failed batch
      batch.forEach(() =>
        embeddings.push(generateDummyEmbedding('fallback', 768))
      )
    }
  }

  console.log(
    `Generated ${embeddings.length} embeddings using Google GenAI SDK`
  )
  return embeddings
}

// Utility function để test các models khác nhau
async function testEmbeddingModels (sampleText = 'Test embedding generation') {
  const models = [
    'text-embedding-004',
    'gemini-embedding-exp-03-07',
    'embedding-001'
  ]

  console.log('Testing different embedding models...')

  for (const model of models) {
    try {
      const embedding = await generateEmbeddingWithModel(sampleText, model)
      console.log(`✅ ${model}: dimension ${embedding.length}`)
    } catch (error) {
      console.log(`❌ ${model}: failed - ${error.message}`)
    }
  }
}

module.exports = {
  generateEmbedding,
  generateBatchEmbeddings,
  generateEmbeddingWithModel,
  testEmbeddingModels,
  initializeGenAI
}
