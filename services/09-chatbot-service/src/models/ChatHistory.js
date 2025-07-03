const mongoose = require('mongoose')

const chatHistorySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    sessionId: { type: String, required: true, index: true },
    message: { type: String, required: true },
    response: { type: String, required: true },
    sources: [
      {
        type: {
          type: String,
          enum: ['event', 'ticket', 'user']
        },
        id: String,
        title: String,
        content: String,
        score: Number,
        additionalInfo: mongoose.Schema.Types.Mixed
      }
    ],
    detectedFilters: [
      {
        type: String,
        enum: ['event', 'ticket', 'user']
      }
    ],
    queryType: {
      type: String,
      enum: ['SPECIFIC', 'LISTING'],
      default: 'SPECIFIC'
    },
    summaryInfo: {
      total_events: Number,
      total_tickets: Number,
      active_events: Number,
      sold_tickets: Number,
      sample_items: [String],
      is_aggregated: Boolean
    },
    confidence: { type: Number, default: 0.8 },
    createdAt: { type: Date, default: Date.now }
  },
  {
    timestamps: true
  }
)

// Indexes for performance
chatHistorySchema.index({ userId: 1, createdAt: -1 })
chatHistorySchema.index({ sessionId: 1, createdAt: -1 })

const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema)

async function saveChatMessage (chatData) {
  try {
    console.log('Saving chat message with data:', {
      id: chatData.id,
      userId: chatData.userId,
      sourcesCount: chatData.sources?.length || 0,
      sourcesStructure: chatData.sources?.[0]
        ? Object.keys(chatData.sources[0])
        : 'no sources'
    })

    const chatHistory = new ChatHistory(chatData)
    await chatHistory.save()
    console.log(`✅ Chat message saved: ${chatData.id}`)
    return chatHistory
  } catch (error) {
    console.error('❌ Error saving chat message:', error)
    throw error
  }
}

async function getChatHistory (userId, sessionId = null, limit = 50) {
  try {
    const query = { userId }
    if (sessionId) {
      query.sessionId = sessionId
    }

    const messages = await ChatHistory.find(query)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()

    console.log(`✅ Retrieved ${messages.length} chat messages for user ${userId}`)
    return messages.reverse() // Return in chronological order
  } catch (error) {
    console.error('❌ Error retrieving chat history:', error)
    return []
  }
}

module.exports = {
  ChatHistory,
  saveChatMessage,
  getChatHistory
}
