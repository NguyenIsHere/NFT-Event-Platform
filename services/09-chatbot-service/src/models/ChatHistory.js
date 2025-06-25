const mongoose = require('mongoose')

const chatHistorySchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
      unique: true
    },
    userId: {
      type: String,
      required: true,
      index: true
    },
    sessionId: {
      type: String,
      required: true,
      index: true
    },
    message: {
      type: String,
      required: true
    },
    response: {
      type: String,
      required: true
    },
    sources: [
      {
        type: {
          type: String,
          enum: ['event', 'ticket', 'user']
        },
        id: String,
        title: String,
        relevance_score: Number
      }
    ],
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  {
    timestamps: true
  }
)

// Indexes
chatHistorySchema.index({ userId: 1, sessionId: 1 })
chatHistorySchema.index({ createdAt: -1 })

const ChatHistory = mongoose.model('ChatHistory', chatHistorySchema)

async function saveChatMessage (chatData) {
  try {
    const chatMessage = new ChatHistory(chatData)
    await chatMessage.save()
    return chatMessage
  } catch (error) {
    console.error('Error saving chat message:', error)
    throw error
  }
}

async function getChatHistory (userId, sessionId, limit = 50) {
  try {
    const filter = { userId }
    if (sessionId) {
      filter.sessionId = sessionId
    }

    const messages = await ChatHistory.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean()

    return messages.reverse() // Oldest first
  } catch (error) {
    console.error('Error getting chat history:', error)
    throw error
  }
}

async function getChatSessions (userId, limit = 20) {
  try {
    const sessions = await ChatHistory.aggregate([
      { $match: { userId } },
      {
        $group: {
          _id: '$sessionId',
          lastMessage: { $last: '$createdAt' },
          messageCount: { $sum: 1 },
          lastUserMessage: { $last: '$message' }
        }
      },
      { $sort: { lastMessage: -1 } },
      { $limit: limit }
    ])

    return sessions
  } catch (error) {
    console.error('Error getting chat sessions:', error)
    throw error
  }
}

module.exports = {
  ChatHistory,
  saveChatMessage,
  getChatHistory,
  getChatSessions
}
