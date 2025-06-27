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
      type: String,
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
    // ✅ ADD: metadataUris field
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
purchaseSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 })

const Purchase = mongoose.model('Purchase', purchaseSchema)

module.exports = { Purchase }
