const mongoose = require('mongoose')
const Schema = mongoose.Schema

const platformTransactionSchema = new Schema(
  {
    transactionHash: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    ticketOrderId: {
      type: String,
      required: true,
      index: true
    },
    eventId: {
      type: String,
      required: true,
      index: true
    },
    eventOrganizerId: {
      type: String,
      required: true,
      index: true
    },
    buyerAddress: {
      type: String,
      required: true,
      lowercase: true,
      index: true
    },
    amountWei: {
      type: String,
      required: true
    },
    platformFeeWei: {
      type: String,
      required: true
    },
    organizerAmountWei: {
      type: String,
      required: true
    },
    platformFeePercent: {
      type: Number,
      required: true,
      default: 5
    },
    status: {
      type: String,
      enum: ['RECEIVED', 'PENDING_SETTLEMENT', 'SETTLED'],
      default: 'RECEIVED',
      index: true
    },
    settledAt: {
      type: Date
    },
    settlementTransactionHash: {
      type: String
    }
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

platformTransactionSchema.virtual('id').get(function () {
  return this._id.toHexString()
})

const PlatformTransaction = mongoose.model(
  'PlatformTransaction',
  platformTransactionSchema
)

module.exports = PlatformTransaction
