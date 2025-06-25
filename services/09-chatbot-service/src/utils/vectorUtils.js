const { Pinecone } = require('@pinecone-database/pinecone')

let pinecone
let index
let mockVectorStore = []

const USE_MOCK_VECTOR = process.env.USE_MOCK_VECTOR === 'true'
const EMBEDDING_DIMENSION = parseInt(process.env.EMBEDDING_DIMENSION) || 768

async function initializeVectorDB () {
  try {
    if (USE_MOCK_VECTOR) {
      console.log('Using mock vector database (in-memory)')
      mockVectorStore = []
      return
    }

    console.log('Initializing Pinecone vector database...')
    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY
    })

    const indexName = process.env.PINECONE_INDEX || 'nft-events-index'

    try {
      // Check if index exists
      const indexList = await pinecone.listIndexes()
      const indexExists = indexList.indexes?.some(idx => idx.name === indexName)

      if (!indexExists) {
        console.log(
          `Creating Pinecone index: ${indexName} with dimension: ${EMBEDDING_DIMENSION}`
        )
        await pinecone.createIndex({
          name: indexName,
          dimension: EMBEDDING_DIMENSION,
          metric: 'cosine',
          spec: {
            serverless: {
              cloud: 'aws',
              region: 'us-east-1'
            }
          },
          waitUntilReady: true // Chờ index ready
        })

        console.log('Pinecone index created successfully')
      } else {
        console.log(`Using existing Pinecone index: ${indexName}`)
      }

      // Initialize index reference
      index = pinecone.index(indexName)

      // Test connection
      const stats = await index.describeIndexStats()
      console.log(
        `Pinecone connected successfully. Total vectors: ${
          stats.totalVectorCount || 0
        }`
      )
    } catch (indexError) {
      console.error('Error with Pinecone index operations:', indexError)
      throw indexError
    }
  } catch (error) {
    console.error('Failed to initialize Pinecone vector database:', error)
    console.log('Falling back to mock vector database')
    mockVectorStore = []

    // Set index to null để trigger mock mode
    index = null
  }
}

async function upsertVectors (vectors) {
  try {
    if (USE_MOCK_VECTOR || !index) {
      // Mock implementation
      vectors.forEach(vector => {
        const existingIndex = mockVectorStore.findIndex(v => v.id === vector.id)
        if (existingIndex >= 0) {
          mockVectorStore[existingIndex] = vector
        } else {
          mockVectorStore.push(vector)
        }
      })
      console.log(
        `Mock: Upserted ${vectors.length} vectors (total: ${mockVectorStore.length})`
      )
      return
    }

    // Validate vectors before upserting
    const validVectors = vectors.filter(vector => {
      if (!vector.id || !vector.values || !Array.isArray(vector.values)) {
        console.warn(`Invalid vector skipped: ${vector.id}`)
        return false
      }
      if (vector.values.length !== EMBEDDING_DIMENSION) {
        console.warn(
          `Vector dimension mismatch: ${vector.id} has ${vector.values.length}, expected ${EMBEDDING_DIMENSION}`
        )
        return false
      }
      return true
    })

    if (validVectors.length === 0) {
      console.warn('No valid vectors to upsert')
      return
    }

    console.log(`Upserting ${validVectors.length} valid vectors to Pinecone...`)

    // Batch upsert để tránh rate limits (Serverless có limits khác)
    const batchSize = 100
    for (let i = 0; i < validVectors.length; i += batchSize) {
      const batch = validVectors.slice(i, i + batchSize)

      try {
        await index.upsert(batch)
        console.log(
          `Upserted batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
            validVectors.length / batchSize
          )}`
        )

        // Rate limiting for Serverless
        if (i + batchSize < validVectors.length) {
          await new Promise(resolve => setTimeout(resolve, 200)) // 200ms delay
        }
      } catch (batchError) {
        console.error(
          `Error upserting batch ${Math.floor(i / batchSize) + 1}:`,
          batchError
        )
        // Continue with next batch
      }
    }

    console.log(
      `Successfully upserted ${validVectors.length} vectors to Pinecone`
    )
  } catch (error) {
    console.error('Failed to upsert vectors:', error)
    throw error
  }
}

async function queryVectors (queryVector, topK = 5, filter = {}) {
  try {
    if (USE_MOCK_VECTOR || !index) {
      // Mock implementation
      const results = mockVectorStore
        .map(vector => ({
          ...vector,
          score: calculateCosineSimilarity(queryVector, vector.values)
        }))
        .filter(vector => {
          if (filter.type && filter.type.$in) {
            return filter.type.$in.includes(vector.metadata.type)
          }
          return true
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, topK)
        .map(vector => ({
          id: vector.id,
          score: vector.score,
          metadata: vector.metadata
        }))

      console.log(`Mock: Found ${results.length} similar vectors`)
      return results
    }

    // Validate query vector
    if (
      !queryVector ||
      !Array.isArray(queryVector) ||
      queryVector.length !== EMBEDDING_DIMENSION
    ) {
      throw new Error(
        `Invalid query vector. Expected dimension: ${EMBEDDING_DIMENSION}, got: ${queryVector?.length}`
      )
    }

    console.log(`Querying Pinecone for ${topK} similar vectors...`)
    const queryResponse = await index.query({
      vector: queryVector,
      topK,
      filter: Object.keys(filter).length > 0 ? filter : undefined,
      includeMetadata: true
    })

    console.log(
      `Pinecone: Found ${queryResponse.matches?.length || 0} similar vectors`
    )
    return queryResponse.matches || []
  } catch (error) {
    console.error('Failed to query vectors:', error)
    throw error
  }
}

// Simple cosine similarity calculation for mock
function calculateCosineSimilarity (vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0

  let dotProduct = 0
  let normA = 0
  let normB = 0

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i]
    normA += vecA[i] * vecA[i]
    normB += vecB[i] * vecB[i]
  }

  if (normA === 0 || normB === 0) return 0
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
}

async function getIndexStats () {
  try {
    if (USE_MOCK_VECTOR || !index) {
      return {
        totalVectorCount: mockVectorStore.length,
        mode: 'mock'
      }
    }

    const stats = await index.describeIndexStats()
    return {
      totalVectorCount: stats.totalVectorCount || 0,
      mode: 'pinecone',
      dimension: EMBEDDING_DIMENSION,
      ...stats
    }
  } catch (error) {
    console.error('Failed to get index stats:', error)
    return { error: error.message }
  }
}

module.exports = {
  initializeVectorDB,
  upsertVectors,
  queryVectors,
  getIndexStats
}
