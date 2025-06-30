const mongoose = require('mongoose')
const Schema = mongoose.Schema

const TRANSACTION_TYPES = [
  'TICKET_PURCHASE', // Mua vé
  'TICKET_MINT', // Mint NFT
  'REVENUE_SETTLEMENT', // Settlement doanh thu
  'PLATFORM_WITHDRAW', // Rút phí platform
  'PLATFORM_FEE_UPDATE', // Cập nhật phí platform
  'EVENT_CREATION', // Tạo event trên blockchain
  'TICKET_TYPE_CREATION', // Tạo ticket type trên blockchain
  'REFUND' // Hoàn tiền (future)
]

const TRANSACTION_STATUS = [
  'PENDING', // Đang xử lý
  'CONFIRMED', // Thành công
  'FAILED', // Thất bại
  'CANCELLED' // Đã hủy
]

const transactionLogSchema = new Schema(
  {
    // Blockchain info
    transactionHash: {
      type: String,
      required: true,
      index: true
    },
    blockNumber: {
      type: Number,
      index: true
    },
    gasUsed: String,
    gasPriceWei: String,

    // Transaction classification
    type: {
      type: String,
      enum: TRANSACTION_TYPES,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: TRANSACTION_STATUS,
      default: 'PENDING',
      index: true
    },

    // Related entities
    eventId: {
      type: String,
      index: true
    },
    organizerId: {
      type: String,
      index: true
    },
    userId: {
      type: String,
      index: true
    },
    ticketTypeId: {
      type: String,
      sparse: true
    },

    // Financial data
    amountWei: {
      type: String,
      default: '0'
    },
    platformFeeWei: {
      type: String,
      default: '0'
    },
    organizerAmountWei: {
      type: String,
      default: '0'
    },
    feePercentAtTime: {
      type: Number,
      default: 0
    },

    // Addresses
    fromAddress: {
      type: String,
      lowercase: true,
      index: true
    },
    toAddress: {
      type: String,
      lowercase: true,
      index: true
    },

    // Metadata
    metadata: {
      type: Map,
      of: Schema.Types.Mixed,
      default: {}
    },

    // Description for admin
    description: String,

    // Reference to original data
    relatedPurchaseId: {
      type: String,
      sparse: true
    },
    relatedTicketIds: [String],

    // Processing info
    processedAt: Date,
    failureReason: String
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
      transform: (doc, ret) => {
        ret.id = ret._id.toString()
        delete ret._id
        delete ret.__v
        return ret
      }
    }
  }
)

// Indexes for analytics
transactionLogSchema.index({ createdAt: -1 })
transactionLogSchema.index({ type: 1, status: 1, createdAt: -1 })
transactionLogSchema.index({ eventId: 1, type: 1, createdAt: -1 })
transactionLogSchema.index({ organizerId: 1, type: 1, createdAt: -1 })

const TransactionLog = mongoose.model('TransactionLog', transactionLogSchema)

module.exports = {
  TransactionLog,
  TRANSACTION_TYPES,
  TRANSACTION_STATUS
}
