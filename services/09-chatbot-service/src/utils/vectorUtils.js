const { Pinecone } = require('@pinecone-database/pinecone')

let pinecone
let index
let mockVectorStore = [] // For mock mode

const USE_MOCK_VECTOR = process.env.USE_MOCK_VECTOR === 'true'

async function initializeVectorDB () {
  try {
    if (USE_MOCK_VECTOR) {
      console.log('Using mock vector database (in-memory)')
      mockVectorStore = []
      return
    }

    pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY
    })

    const indexName = process.env.PINECONE_INDEX || 'nft-events-index'
    index = pinecone.index(indexName)

    console.log('Vector database initialized successfully')
  } catch (error) {
    console.error('Failed to initialize vector database:', error)
    console.log('Falling back to mock vector database')
    mockVectorStore = []
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

    await index.upsert(vectors)
    console.log(`Upserted ${vectors.length} vectors`)
  } catch (error) {
    console.error('Failed to upsert vectors:', error)
    throw error
  }
}

async function queryVectors (queryVector, topK = 5, filter = {}) {
  try {
    if (USE_MOCK_VECTOR || !index) {
      // Mock implementation with simple similarity calculation
      const results = mockVectorStore
        .map(vector => ({
          ...vector,
          score: calculateCosineSimilarity(queryVector, vector.values)
        }))
        .filter(vector => {
          // Apply basic filter
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

    const queryResponse = await index.query({
      vector: queryVector,
      topK,
      filter,
      includeMetadata: true
    })

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

module.exports = {
  initializeVectorDB,
  upsertVectors,
  queryVectors
}
