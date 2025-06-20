// 📁 services/05-ticket-service/src/handlers/settlementHandlers.js

const PlatformTransaction = require('../models/PlatformTransaction')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')

// Get settlement summary for an event
async function GetEventSettlementSummary (call, callback) {
  const { event_id } = call.request
  console.log(
    `SettlementService: GetEventSettlementSummary for event: ${event_id}`
  )

  try {
    // Tính tổng transactions
    const summary = await PlatformTransaction.aggregate([
      { $match: { eventId: event_id } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalAmount: { $sum: { $toDecimal: '$amountWei' } },
          totalPlatformFee: { $sum: { $toDecimal: '$platformFeeWei' } },
          totalOrganizerAmount: { $sum: { $toDecimal: '$organizerAmountWei' } }
        }
      }
    ])

    let receivedSummary = {
      count: 0,
      totalAmount: '0',
      totalPlatformFee: '0',
      totalOrganizerAmount: '0'
    }
    let settledSummary = {
      count: 0,
      totalAmount: '0',
      totalPlatformFee: '0',
      totalOrganizerAmount: '0'
    }

    summary.forEach(item => {
      if (item._id === 'RECEIVED') {
        receivedSummary = {
          count: item.count,
          totalAmount: item.totalAmount.toString(),
          totalPlatformFee: item.totalPlatformFee.toString(),
          totalOrganizerAmount: item.totalOrganizerAmount.toString()
        }
      } else if (item._id === 'SETTLED') {
        settledSummary = {
          count: item.count,
          totalAmount: item.totalAmount.toString(),
          totalPlatformFee: item.totalPlatformFee.toString(),
          totalOrganizerAmount: item.totalOrganizerAmount.toString()
        }
      }
    })

    callback(null, {
      event_id: event_id,
      received_summary: receivedSummary,
      settled_summary: settledSummary
    })
  } catch (error) {
    console.error('GetEventSettlementSummary error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get settlement summary'
    })
  }
}

// Process settlement for an event
async function ProcessEventSettlement (call, callback) {
  const { event_id, settlement_transaction_hash } = call.request
  console.log(
    `SettlementService: ProcessEventSettlement for event: ${event_id}`
  )

  try {
    // Lấy tất cả transactions chưa settle
    const unsettledTxs = await PlatformTransaction.find({
      eventId: event_id,
      status: 'RECEIVED'
    })

    if (unsettledTxs.length === 0) {
      return callback({
        code: grpc.status.NOT_FOUND,
        message: 'No unsettled transactions found for this event'
      })
    }

    // Tính tổng tiền
    const totalOrganizerAmount = unsettledTxs.reduce(
      (sum, tx) => sum + BigInt(tx.organizerAmountWei),
      BigInt(0)
    )

    const totalPlatformFee = unsettledTxs.reduce(
      (sum, tx) => sum + BigInt(tx.platformFeeWei),
      BigInt(0)
    )

    // Cập nhật status của tất cả transactions
    const updateResult = await PlatformTransaction.updateMany(
      { eventId: event_id, status: 'RECEIVED' },
      {
        status: 'SETTLED',
        settledAt: new Date(),
        settlementTransactionHash:
          settlement_transaction_hash || 'MANUAL_SETTLEMENT'
      }
    )

    console.log(
      `SettlementService: Settled ${updateResult.modifiedCount} transactions for event ${event_id}`
    )

    callback(null, {
      success: true,
      event_id: event_id,
      settled_transactions_count: updateResult.modifiedCount,
      total_organizer_amount_wei: totalOrganizerAmount.toString(),
      total_platform_fee_wei: totalPlatformFee.toString(),
      settlement_transaction_hash:
        settlement_transaction_hash || 'MANUAL_SETTLEMENT'
    })
  } catch (error) {
    console.error('ProcessEventSettlement error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to process settlement'
    })
  }
}

// List platform transactions
async function ListPlatformTransactions (call, callback) {
  const { event_id, status_filter, page_size = 20, page_token } = call.request
  console.log(
    `SettlementService: ListPlatformTransactions for event: ${event_id}`
  )

  try {
    const query = {}
    if (event_id) query.eventId = event_id
    if (status_filter) query.status = status_filter

    const limit = Math.min(page_size, 100)
    let skip = 0

    if (page_token) {
      try {
        skip = parseInt(page_token)
      } catch (e) {
        skip = 0
      }
    }

    const transactions = await PlatformTransaction.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit + 1)

    const hasMore = transactions.length > limit
    const transactionsToReturn = hasMore
      ? transactions.slice(0, limit)
      : transactions
    const nextPageToken = hasMore ? (skip + limit).toString() : ''

    callback(null, {
      transactions: transactionsToReturn.map(tx => ({
        id: tx.id,
        transaction_hash: tx.transactionHash,
        ticket_order_id: tx.ticketOrderId,
        event_id: tx.eventId,
        event_organizer_id: tx.eventOrganizerId,
        buyer_address: tx.buyerAddress,
        amount_wei: tx.amountWei,
        platform_fee_wei: tx.platformFeeWei,
        organizer_amount_wei: tx.organizerAmountWei,
        platform_fee_percent: tx.platformFeePercent,
        status: tx.status,
        created_at: Math.floor(tx.createdAt.getTime() / 1000),
        settled_at: tx.settledAt
          ? Math.floor(tx.settledAt.getTime() / 1000)
          : 0,
        settlement_transaction_hash: tx.settlementTransactionHash || ''
      })),
      next_page_token: nextPageToken
    })
  } catch (error) {
    console.error('ListPlatformTransactions error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to list platform transactions'
    })
  }
}

module.exports = {
  GetEventSettlementSummary,
  ProcessEventSettlement,
  ListPlatformTransactions
}
