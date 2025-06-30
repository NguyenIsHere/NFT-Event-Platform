const mongoose = require('mongoose')
const Schema = mongoose.Schema

const purchaseSchema = new Schema(
  {
    purchaseId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    ticketTypeId: {
      type: Schema.Types.ObjectId,
      ref: 'TicketType',
      required: true
    },
    quantity: {
      type: Number,
      required: true
    },
    walletAddress: {
      type: String,
      required: true,
      lowercase: true
    },
    selectedSeats: [
      {
        type: String
      }
    ],
    status: {
      type: String,
      enum: ['INITIATED', 'CONFIRMED', 'EXPIRED', 'FAILED'],
      default: 'INITIATED'
    },
    transactionHash: {
      type: String,
      sparse: true
    },
    expiresAt: {
      type: Date,
      required: true
    },
    purchaseDetails: {
      type: Object,
      required: true
    },
    metadataUris: [
      {
        type: String
      }
    ]
  },
  {
    timestamps: true
  }
)

// Auto-expire purchases after 15 minutes
purchaseSchema.index({ expiresAt: 1 })
purchaseSchema.index({ status: 1 })
purchaseSchema.index({ walletAddress: 1, status: 1 })

const Purchase = mongoose.model('Purchase', purchaseSchema)

module.exports = { Purchase }
