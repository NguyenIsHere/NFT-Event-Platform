// services/05-ticket-service/src/handlers/analyticsHandlers.js
const { Ticket, TicketType, TICKET_STATUS_ENUM } = require('../models/Ticket')
const {
  TransactionLog,
  TRANSACTION_TYPES
} = require('../models/TransactionLog')
const TransactionLogger = require('../utils/transactionLogger')
const grpc = require('@grpc/grpc-js')
const mongoose = require('mongoose')

async function GetEventDashboard (call, callback) {
  const { event_id, date_range } = call.request

  try {
    const now = new Date()
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : now

    // ✅ REPLACE: Purchase analytics with TransactionLog analytics
    const purchaseStats = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          totalQuantity: { $sum: { $toInt: '$metadata.quantity' } },
          totalAmountWei: {
            $sum: { $toLong: '$amountWei' }
          },
          totalPlatformFeeWei: {
            $sum: { $toLong: '$platformFeeWei' }
          },
          totalOrganizerAmountWei: {
            $sum: { $toLong: '$organizerAmountWei' }
          }
        }
      }
    ])

    // ✅ TICKET stats from Ticket collection (current state)
    const ticketStats = await Ticket.aggregate([
      {
        $match: {
          eventId: event_id,
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ])

    // ✅ DAILY trends from TransactionLog
    const dailySales = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          ticketsSold: { $sum: { $toInt: '$metadata.quantity' } },
          transactionCount: { $sum: 1 },
          revenue: { $sum: { $toLong: '$amountWei' } }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ])

    // ✅ CALCULATE totals from confirmed transactions
    const confirmedPurchases = purchaseStats.find(p => p._id === 'CONFIRMED')
    const totalRevenue = confirmedPurchases?.totalAmountWei || 0
    const platformFee = confirmedPurchases?.totalPlatformFeeWei || 0
    const organizerRevenue = confirmedPurchases?.totalOrganizerAmountWei || 0

    // ✅ CONVERSION rate calculation
    const totalTransactions = purchaseStats.reduce(
      (sum, stat) => sum + stat.count,
      0
    )
    const confirmedTransactions = confirmedPurchases?.count || 0
    const conversionRate =
      totalTransactions > 0
        ? ((confirmedTransactions / totalTransactions) * 100).toFixed(2)
        : '0.00'

    // ✅ NEW: Purchase flow analysis từ TransactionLog
    const purchaseFlow = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          avgCompletionTime: { $avg: '$metadata.completion_time_ms' }
        }
      }
    ])

    // ✅ NEW: Recent transactions for timeline
    const recentTransactions = await TransactionLog.find({
      eventId: event_id,
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } // Last 24h
    })
      .sort({ createdAt: -1 })
      .limit(20)

    // ✅ NEW: Revenue by ticket type
    const revenueByTicketType = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED'
        }
      },
      {
        $group: {
          _id: '$ticketTypeId',
          revenue_wei: { $sum: { $toLong: '$amountWei' } },
          tickets_sold: { $sum: { $toInt: '$metadata.quantity' } }
        }
      }
    ])

    // ✅ NEW: Revenue by hour
    const revenueByHour = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED'
        }
      },
      {
        $group: {
          _id: { $hour: '$createdAt' },
          revenue_wei: { $sum: { $toLong: '$amountWei' } },
          transaction_count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ])

    // ✅ NEW: Payment method analysis từ TransactionLog
    const paymentMethodAnalysis = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            paymentMethod: { $ifNull: ['$metadata.paymentMethod', 'WALLET'] },
            status: '$status'
          },
          count: { $sum: 1 },
          totalAmount: { $sum: { $toLong: '$amountWei' } },
          avgGasUsed: { $avg: { $toDouble: '$gasUsed' } },
          avgGasPrice: { $avg: { $toDouble: '$gasPriceWei' } }
        }
      },
      {
        $group: {
          _id: '$_id.paymentMethod',
          totalTransactions: { $sum: '$count' },
          confirmedTransactions: {
            $sum: {
              $cond: [{ $eq: ['$_id.status', 'CONFIRMED'] }, '$count', 0]
            }
          },
          failedTransactions: {
            $sum: {
              $cond: [{ $eq: ['$_id.status', 'FAILED'] }, '$count', 0]
            }
          },
          totalRevenue: { $sum: '$totalAmount' },
          avgGasUsed: { $avg: '$avgGasUsed' },
          avgGasPrice: { $avg: '$avgGasPrice' }
        }
      }
    ])

    // ✅ NEW: Gas analysis
    const gasAnalysis = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          gasUsed: { $exists: true, $ne: null, $ne: '' },
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          avgGasUsed: { $avg: { $toDouble: '$gasUsed' } },
          maxGasUsed: { $max: { $toDouble: '$gasUsed' } },
          minGasUsed: { $min: { $toDouble: '$gasUsed' } },
          avgGasPriceGwei: {
            $avg: {
              $divide: [{ $toDouble: '$gasPriceWei' }, 1000000000] // Convert Wei to Gwei
            }
          },
          totalGasCostWei: {
            $sum: {
              $multiply: [
                { $toDouble: '$gasUsed' },
                { $toDouble: '$gasPriceWei' }
              ]
            }
          }
        }
      }
    ])

    // ✅ NEW: Failure analysis
    const failureAnalysis = await TransactionLog.aggregate([
      {
        $match: {
          eventId: event_id,
          type: 'TICKET_PURCHASE',
          status: 'FAILED',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: { $ifNull: ['$failureReason', 'Unknown Error'] },
          count: { $sum: 1 }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ])

    // ✅ Transform payment method data
    const paymentMethods = paymentMethodAnalysis.map(pm => ({
      name: pm._id || 'Wallet',
      type: pm._id === 'CREDIT_CARD' ? 'CREDIT_CARD' : 'WALLET',
      count: pm.totalTransactions,
      success_rate:
        pm.totalTransactions > 0
          ? ((pm.confirmedTransactions / pm.totalTransactions) * 100).toFixed(1)
          : '0.0'
    }))

    // ✅ Gas analysis data
    const gasData = gasAnalysis[0] || {}
    const gasAnalysisResult = {
      avg_gas_used: gasData.avgGasUsed
        ? Math.round(gasData.avgGasUsed).toString()
        : 'N/A',
      avg_gas_price_gwei: gasData.avgGasPriceGwei
        ? gasData.avgGasPriceGwei.toFixed(2)
        : 'N/A',
      total_gas_cost_eth: gasData.totalGasCostWei
        ? (gasData.totalGasCostWei / Math.pow(10, 18)).toFixed(6)
        : 'N/A'
    }

    // ✅ Failure reasons
    const failureReasons = failureAnalysis.map(failure => ({
      reason: failure._id,
      count: failure.count
    }))

    const dashboard = {
      event_id,
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      ticket_summary: {
        total_tickets: await Ticket.countDocuments({ eventId: event_id }),
        by_status: ticketStats.map(stat => ({
          status: stat._id,
          count: stat.count
        }))
      },

      purchase_summary: {
        total_purchases: totalTransactions,
        conversion_rate: conversionRate,
        abandonment_rate: (100 - parseFloat(conversionRate)).toFixed(2),
        by_status: purchaseStats.map(stat => ({
          status: stat._id,
          count: stat.count,
          total_quantity: stat.totalQuantity || 0,
          total_value_wei: stat.totalAmountWei?.toString() || '0'
        }))
      },

      revenue_summary: {
        total_revenue_wei: totalRevenue.toString(),
        platform_fees_wei: platformFee.toString(),
        organizer_revenue_wei: organizerRevenue.toString(),
        transaction_count: confirmedTransactions
      },

      daily_trends: dailySales.map(sale => ({
        date: `${sale._id.year}-${sale._id.month
          .toString()
          .padStart(2, '0')}-${sale._id.day.toString().padStart(2, '0')}`,
        tickets_sold: sale.ticketsSold,
        purchase_count: sale.transactionCount,
        revenue_wei: sale.revenue.toString()
      })),

      // ✅ FIX: Correct field names and data structure
      purchase_flow: purchaseFlow.map(pf => ({
        status: pf._id,
        count: pf.count,
        avg_completion_time_ms: Math.round(pf.avgCompletionTime || 0)
      })),

      recent_transactions: recentTransactions.map(tx => ({
        id: tx._id.toString(),
        type: tx.type,
        status: tx.status,
        created_at: tx.createdAt.toISOString(),
        description: tx.description || 'No description',
        amount_wei: tx.amountWei || '0',
        transaction_hash: tx.transactionHash || ''
      })),

      revenue_by_ticket_type: revenueByTicketType.map(r => ({
        ticket_type_id: r._id?.toString() || '',
        name: `Type ${r._id?.toString().substring(0, 8) || 'Unknown'}...`,
        revenue_wei: r.revenue_wei?.toString() || '0',
        tickets_sold: r.tickets_sold || 0
      })),

      revenue_by_hour: revenueByHour.map(r => ({
        hour: r._id || 0,
        revenue_wei: r.revenue_wei?.toString() || '0',
        transaction_count: r.transaction_count || 0
      })),

      payment_methods: paymentMethods.map(pm => ({
        name: pm.name || pm._id || 'Unknown',
        type: pm.type || pm._id || 'WALLET',
        count: pm.count || 0,
        success_rate: pm.success_rate?.toString() || '0.0'
      })),

      gas_analysis: {
        avg_gas_used: gasAnalysisResult.avg_gas_used || 'N/A',
        avg_gas_price_gwei: gasAnalysisResult.avg_gas_price_gwei || 'N/A',
        total_gas_cost_eth: gasAnalysisResult.total_gas_cost_eth || 'N/A'
      },

      failure_reasons: failureReasons.map(fr => ({
        reason: fr._id || 'Unknown',
        count: fr.count || 0
      }))
    }

    // ✅ DEBUG: Log the actual structure being sent
    console.log('📊 Dashboard structure check:', {
      purchase_flow_length: dashboard.purchase_flow?.length,
      recent_transactions_length: dashboard.recent_transactions?.length,
      revenue_by_ticket_type_length: dashboard.revenue_by_ticket_type?.length,
      revenue_by_hour_length: dashboard.revenue_by_hour?.length,
      payment_methods_length: dashboard.payment_methods?.length,
      has_gas_analysis: !!dashboard.gas_analysis,
      failure_reasons_length: dashboard.failure_reasons?.length
    })

    // ✅ DEBUG: Log first few items of each array
    if (dashboard.purchase_flow?.length > 0) {
      console.log('📊 Sample purchase_flow:', dashboard.purchase_flow[0])
    }
    if (dashboard.recent_transactions?.length > 0) {
      console.log(
        '📊 Sample recent_transaction:',
        dashboard.recent_transactions[0]
      )
    }

    callback(null, dashboard)
  } catch (error) {
    console.error('❌ GetEventDashboard error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get event dashboard'
    })
  }
}

async function GetOrganizerStats (call, callback) {
  const { organizer_id } = call.request

  try {
    console.log('🔍 GetOrganizerStats for:', organizer_id)

    // Get all events của organizer
    const eventServiceClient = require('../clients/eventServiceClient')
    const eventsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.ListEvents(
        { organizer_id: organizer_id },
        { deadline: new Date(Date.now() + 10000) },
        (err, res) => {
          if (err) reject(err)
          else resolve(res)
        }
      )
    })

    const eventIds = eventsResponse.events?.map(e => e.id) || []
    console.log('📋 Found events for organizer:', eventIds.length)

    if (eventIds.length === 0) {
      return callback(null, {
        organizer_id,
        total_events: 0,
        total_tickets_sold: 0,
        total_revenue_wei: '0',
        active_events: 0
      })
    }

    // ❌ REMOVE: Purchase-based analytics
    // const allTicketTypes = await TicketType.find({ eventId: { $in: eventIds } })
    // const revenueStats = await Purchase.aggregate([...])

    // ✅ REPLACE: TransactionLog-based analytics
    const revenueStats = await TransactionLog.aggregate([
      {
        $match: {
          organizerId: organizer_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED'
        }
      },
      {
        $group: {
          _id: null,
          totalTicketsSold: {
            $sum: { $toInt: '$metadata.quantity' }
          },
          totalRevenue: {
            $sum: { $toLong: '$organizerAmountWei' }
          },
          uniqueEvents: { $addToSet: '$eventId' }
        }
      }
    ])

    const stats = revenueStats[0] || {
      totalTicketsSold: 0,
      totalRevenue: 0,
      uniqueEvents: []
    }

    console.log('✅ Organizer stats:', {
      totalEvents: eventIds.length,
      totalTicketsSold: stats.totalTicketsSold,
      totalRevenue: stats.totalRevenue
    })

    callback(null, {
      organizer_id,
      total_events: eventIds.length,
      total_tickets_sold: stats.totalTicketsSold,
      total_revenue_wei: stats.totalRevenue.toString(),
      active_events: stats.uniqueEvents.length
    })
  } catch (error) {
    console.error('❌ Analytics: GetOrganizerStats error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get organizer stats'
    })
  }
}

// Check-in analytics cho event staff
async function GetCheckinAnalytics (call, callback) {
  const { event_id, time_period } = call.request

  try {
    console.log(`🔍 GetCheckinAnalytics called:`, {
      event_id,
      time_period,
      timestamp: new Date().toISOString()
    })

    // ✅ FIX: Base query - chỉ lấy tickets đã minted và có check-in time
    const baseMatch = {
      eventId: event_id,
      status: TICKET_STATUS_ENUM[4], // MINTED
      checkInStatus: 'CHECKED_IN',
      checkInTime: { $exists: true, $ne: null }
    }

    // ✅ FIX: Time range filtering
    if (time_period === 'TODAY') {
      const today = new Date()
      const startOfToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        0,
        0,
        0,
        0
      )
      const endOfToday = new Date(
        today.getFullYear(),
        today.getMonth(),
        today.getDate(),
        23,
        59,
        59,
        999
      )

      baseMatch.checkInTime = {
        $gte: startOfToday,
        $lte: endOfToday
      }

      console.log(`📅 TODAY filter applied:`, {
        startOfToday: startOfToday.toISOString(),
        endOfToday: endOfToday.toISOString(),
        currentTime: new Date().toISOString()
      })
    } else if (time_period === 'WEEK') {
      const today = new Date()
      const startOfWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000)
      baseMatch.checkInTime = { $gte: startOfWeek }
    }

    console.log(`🔍 Base match query:`, JSON.stringify(baseMatch, null, 2))

    // ✅ FIX: Debug - count total matching tickets first
    const totalMatchingTickets = await Ticket.countDocuments(baseMatch)
    console.log(`📊 Total tickets matching criteria: ${totalMatchingTickets}`)

    // ✅ FIX: Hourly check-in trend với same base query
    const hourlyCheckins = await Ticket.aggregate([
      { $match: baseMatch }, // ✅ Same base query
      {
        $addFields: {
          checkInHour: {
            $hour: { date: '$checkInTime', timezone: 'Asia/Ho_Chi_Minh' }
          }
        }
      },
      {
        $group: {
          _id: '$checkInHour',
          count: { $sum: 1 },
          tickets: {
            $push: {
              id: '$_id',
              checkInTime: '$checkInTime'
            }
          }
        }
      },
      { $sort: { _id: 1 } }
    ])

    console.log(
      `📊 Hourly checkins aggregation result:`,
      JSON.stringify(hourlyCheckins, null, 2)
    )

    // ✅ FIX: Check-in by location với SAME base query
    const locationStats = await Ticket.aggregate([
      { $match: baseMatch }, // ✅ Use same base query instead of separate query
      {
        $group: {
          _id: '$checkInLocation',
          count: { $sum: 1 },
          tickets: {
            $push: {
              id: '$_id',
              checkInTime: '$checkInTime',
              location: '$checkInLocation'
            }
          }
        }
      }
    ])

    console.log(
      `📍 Location stats result:`,
      JSON.stringify(locationStats, null, 2)
    )

    // ✅ FIX: Summary statistics - use overall event query (no time filter)
    const summaryQuery = {
      eventId: event_id,
      status: TICKET_STATUS_ENUM[4] // MINTED only
    }

    const summary = await Ticket.aggregate([
      { $match: summaryQuery },
      {
        $group: {
          _id: '$checkInStatus',
          count: { $sum: 1 }
        }
      }
    ])

    console.log(`📋 Check-in summary:`, JSON.stringify(summary, null, 2))

    const response = {
      event_id,
      time_period: time_period || 'ALL',
      hourly_checkins: hourlyCheckins.map(h => ({
        hour: h._id,
        count: h.count
      })),
      location_breakdown: locationStats.map(l => ({
        location: l._id || 'Unknown',
        count: l.count
      })),
      summary: {
        total_checked_in: summary.find(s => s._id === 'CHECKED_IN')?.count || 0,
        total_not_checked_in:
          summary.find(s => s._id === 'NOT_CHECKED_IN')?.count || 0
      }
    }

    console.log(`✅ Final response:`, JSON.stringify(response, null, 2))

    callback(null, response)
  } catch (error) {
    console.error('❌ Analytics: GetCheckinAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get checkin analytics'
    })
  }
}

// ✅ NEW: Admin analytics function
async function GetAdminAnalytics (call, callback) {
  const { date_range, transaction_type } = call.request

  try {
    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : new Date()

    // Get transaction logs based on TransactionLog model
    const filters = {
      fromDate: startDate,
      toDate: endDate,
      status: 'CONFIRMED'
    }

    if (transaction_type) {
      filters.type = transaction_type
    }

    const { logs } = await TransactionLogger.getTransactionLogs(filters)

    // Process logs for analytics
    const transactionSummary = {}
    const dailyTrends = {}
    const eventRevenue = {}

    logs.forEach(log => {
      // Transaction summary
      if (!transactionSummary[log.type]) {
        transactionSummary[log.type] = {
          count: 0,
          totalAmountWei: BigInt(0),
          totalPlatformFeeWei: BigInt(0),
          totalOrganizerAmountWei: BigInt(0)
        }
      }

      transactionSummary[log.type].count++
      transactionSummary[log.type].totalAmountWei += BigInt(
        log.amountWei || '0'
      )
      transactionSummary[log.type].totalPlatformFeeWei += BigInt(
        log.platformFeeWei || '0'
      )
      transactionSummary[log.type].totalOrganizerAmountWei += BigInt(
        log.organizerAmountWei || '0'
      )

      // Daily trends
      const dateKey = log.createdAt.toISOString().split('T')[0]
      const trendKey = `${dateKey}-${log.type}`

      if (!dailyTrends[trendKey]) {
        dailyTrends[trendKey] = {
          date: dateKey,
          type: log.type,
          count: 0,
          totalAmountWei: BigInt(0)
        }
      }

      dailyTrends[trendKey].count++
      dailyTrends[trendKey].totalAmountWei += BigInt(log.amountWei || '0')

      // Event revenue (only for ticket purchases)
      if (log.type === 'TICKET_PURCHASE' && log.eventId) {
        if (!eventRevenue[log.eventId]) {
          eventRevenue[log.eventId] = {
            eventId: log.eventId,
            ticketsSold: 0,
            totalRevenue: BigInt(0),
            organizerRevenue: BigInt(0),
            platformFees: BigInt(0)
          }
        }

        eventRevenue[log.eventId].ticketsSold += log.metadata?.quantity || 1
        eventRevenue[log.eventId].totalRevenue += BigInt(log.amountWei || '0')
        eventRevenue[log.eventId].organizerRevenue += BigInt(
          log.organizerAmountWei || '0'
        )
        eventRevenue[log.eventId].platformFees += BigInt(
          log.platformFeeWei || '0'
        )
      }
    })

    // Convert to response format
    const response = {
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      transaction_summary: Object.entries(transactionSummary).map(
        ([type, data]) => ({
          type,
          count: data.count,
          total_amount_wei: data.totalAmountWei.toString(),
          total_platform_fee_wei: data.totalPlatformFeeWei.toString(),
          total_organizer_amount_wei: data.totalOrganizerAmountWei.toString()
        })
      ),
      daily_trends: Object.values(dailyTrends).map(trend => ({
        date: trend.date,
        type: trend.type,
        count: trend.count,
        total_amount_wei: trend.totalAmountWei.toString()
      })),
      top_events_by_revenue: Object.values(eventRevenue)
        .sort((a, b) => Number(b.totalRevenue - a.totalRevenue))
        .slice(0, 10)
        .map(event => ({
          event_id: event.eventId,
          tickets_sold: event.ticketsSold,
          total_revenue_wei: event.totalRevenue.toString(),
          organizer_revenue_wei: event.organizerRevenue.toString(),
          platform_fees_wei: event.platformFees.toString()
        }))
    }

    callback(null, response)
  } catch (error) {
    console.error('❌ GetAdminAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get admin analytics'
    })
  }
}

async function GetOrganizerAnalytics (call, callback) {
  const { organizer_id, date_range } = call.request

  try {
    console.log('🔍 GetOrganizerAnalytics for:', organizer_id)

    const startDate = date_range?.start_date
      ? new Date(date_range.start_date * 1000)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    const endDate = date_range?.end_date
      ? new Date(date_range.end_date * 1000)
      : new Date()

    console.log('📅 Date range:', { startDate, endDate })

    // ✅ 1. Get organizer's events from Event service
    const eventServiceClient = require('../clients/eventServiceClient')
    const eventsResponse = await new Promise((resolve, reject) => {
      eventServiceClient.ListEvents(
        { organizer_id: organizer_id },
        (err, res) => {
          if (err) reject(err)
          else resolve(res)
        }
      )
    })

    const events = eventsResponse.events || []
    const eventIds = events.map(e => e.id)

    console.log('📋 Found events for organizer:', events.length)
    console.log('🎯 Event IDs:', eventIds)

    if (eventIds.length === 0) {
      return callback(null, {
        organizer_id,
        date_range: {
          start_date: Math.floor(startDate.getTime() / 1000),
          end_date: Math.floor(endDate.getTime() / 1000)
        },
        total_events: 0,
        total_tickets_sold: 0,
        total_revenue_wei: '0',
        event_breakdown: [],
        transaction_summary: [],
        daily_trends: []
      })
    }

    // ✅ 2. Get TransactionLog data for revenue analytics
    const transactionStats = await TransactionLog.aggregate([
      {
        $match: {
          organizerId: organizer_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: null,
          totalTicketsSold: { $sum: { $toInt: '$metadata.quantity' } },
          totalRevenueWei: { $sum: { $toLong: '$organizerAmountWei' } },
          totalPlatformFeeWei: { $sum: { $toLong: '$platformFeeWei' } }
        }
      }
    ])

    // ✅ 3. Get event breakdown data
    const eventBreakdownData = await TransactionLog.aggregate([
      {
        $match: {
          organizerId: organizer_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          eventId: { $in: eventIds }
        }
      },
      {
        $group: {
          _id: '$eventId',
          tickets_sold: { $sum: { $toInt: '$metadata.quantity' } },
          total_revenue_wei: { $sum: { $toLong: '$organizerAmountWei' } },
          platform_fees_paid_wei: { $sum: { $toLong: '$platformFeeWei' } }
        }
      }
    ])

    // ✅ 4. Get daily trends
    const dailyTrends = await TransactionLog.aggregate([
      {
        $match: {
          organizerId: organizer_id,
          type: 'TICKET_PURCHASE',
          status: 'CONFIRMED',
          createdAt: { $gte: startDate, $lte: endDate }
        }
      },
      {
        $group: {
          _id: {
            year: { $year: '$createdAt' },
            month: { $month: '$createdAt' },
            day: { $dayOfMonth: '$createdAt' }
          },
          tickets_sold: { $sum: { $toInt: '$metadata.quantity' } },
          revenue_wei: { $sum: { $toLong: '$organizerAmountWei' } }
        }
      },
      { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1 } }
    ])

    // ✅ 5. Create events lookup map
    const eventsMap = {}
    events.forEach(event => {
      eventsMap[event.id] = event
    })

    // ✅ 6. Calculate totals
    const stats = transactionStats[0] || {
      totalTicketsSold: 0,
      totalRevenueWei: 0,
      totalPlatformFeeWei: 0
    }

    // ✅ 7. Format event breakdown
    const eventBreakdown = eventBreakdownData.map(breakdown => {
      const event = eventsMap[breakdown._id] || {}
      return {
        event_id: breakdown._id,
        event_name: event.name || `Event ${breakdown._id.substring(0, 8)}`,
        status: event.status || 'UNKNOWN',
        tickets_sold: breakdown.tickets_sold,
        total_revenue_wei: breakdown.total_revenue_wei.toString(),
        platform_fees_paid_wei: breakdown.platform_fees_paid_wei.toString(),
        conversion_rate: 0 // ✅ TODO: Calculate conversion rate
      }
    })

    // ✅ 8. Format daily trends
    const dailyTrendsFormatted = dailyTrends.map(trend => ({
      date: `${trend._id.year}-${trend._id.month
        .toString()
        .padStart(2, '0')}-${trend._id.day.toString().padStart(2, '0')}`,
      tickets_sold: trend.tickets_sold,
      revenue_wei: trend.revenue_wei.toString()
    }))

    const response = {
      organizer_id,
      date_range: {
        start_date: Math.floor(startDate.getTime() / 1000),
        end_date: Math.floor(endDate.getTime() / 1000)
      },
      // ✅ FIX: Add total fields that frontend expects
      total_events: events.length,
      total_tickets_sold: stats.totalTicketsSold,
      total_revenue_wei: stats.totalRevenueWei.toString(),

      // ✅ FIX: Add detailed breakdown
      event_breakdown: eventBreakdown,
      transaction_summary: [], // ✅ TODO: Add if needed
      daily_trends: dailyTrendsFormatted
    }

    console.log('✅ GetOrganizerAnalytics response:', {
      organizer_id: response.organizer_id,
      total_events: response.total_events,
      total_tickets_sold: response.total_tickets_sold,
      total_revenue_wei: response.total_revenue_wei,
      event_breakdown_count: response.event_breakdown.length,
      daily_trends_count: response.daily_trends.length,
      sample_event_breakdown: response.event_breakdown[0],
      sample_daily_trend: response.daily_trends[0]
    })

    callback(null, response)
  } catch (error) {
    console.error('❌ GetOrganizerAnalytics error:', error)
    callback({
      code: grpc.status.INTERNAL,
      message: error.message || 'Failed to get organizer analytics'
    })
  }
}

async function LogRevenueSettlement (call, callback) {
  try {
    const {
      transaction_hash,
      block_number,
      gas_used,
      gas_price_wei,
      event_id,
      organizer_id,
      organizer_amount_wei,
      platform_fee_wei,
      organizer_address,
      event_name
    } = call.request

    console.log('📝 LogRevenueSettlement called:', {
      transaction_hash,
      event_id,
      organizer_id,
      organizer_amount_wei,
      platform_fee_wei,
      event_name
    })

    // ✅ Use TransactionLogger for consistency
    const logResult = await TransactionLogger.logRevenueSettlement({
      transactionHash: transaction_hash,
      blockNumber: Number(block_number),
      gasUsed: gas_used,
      gasPriceWei: gas_price_wei,
      eventId: event_id,
      organizerId: organizer_id,
      organizerAmountWei: organizer_amount_wei,
      platformFeeWei: platform_fee_wei,
      organizerAddress: organizer_address,
      eventName: event_name
    })

    console.log('✅ Revenue settlement logged successfully:', logResult.id)

    callback(null, {
      success: true,
      message: 'Revenue settlement logged successfully',
      log_id: logResult.id
    })
  } catch (error) {
    console.error('❌ LogRevenueSettlement error:', error)
    callback(null, {
      success: false,
      message: error.message || 'Failed to log revenue settlement',
      log_id: ''
    })
  }
}

// ✅ NEW: Log platform withdraw từ blockchain service
async function LogPlatformWithdraw (call, callback) {
  try {
    const {
      transaction_hash,
      block_number,
      gas_used,
      gas_price_wei,
      amount_wei,
      admin_address
    } = call.request

    console.log('📝 LogPlatformWithdraw called:', {
      transaction_hash,
      amount_wei,
      admin_address
    })

    // ✅ Use TransactionLogger for consistency
    const logResult = await TransactionLogger.logPlatformWithdraw({
      transactionHash: transaction_hash,
      blockNumber: Number(block_number),
      gasUsed: gas_used,
      gasPriceWei: gas_price_wei,
      amountWei: amount_wei,
      adminAddress: admin_address
    })

    console.log('✅ Platform withdraw logged successfully:', logResult.id)

    callback(null, {
      success: true,
      message: 'Platform withdraw logged successfully',
      log_id: logResult.id
    })
  } catch (error) {
    console.error('❌ LogPlatformWithdraw error:', error)
    callback(null, {
      success: false,
      message: error.message || 'Failed to log platform withdraw',
      log_id: ''
    })
  }
}

module.exports = {
  GetEventDashboard,
  GetOrganizerStats,
  GetCheckinAnalytics,
  GetAdminAnalytics,
  GetOrganizerAnalytics, // ✅ NEW
  LogRevenueSettlement, // ✅ NEW
  LogPlatformWithdraw // ✅ NEW
}
