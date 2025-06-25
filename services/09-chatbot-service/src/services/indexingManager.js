// src/services/indexingManager.js
const { getIndexStats } = require('../utils/vectorUtils')
const eventClient = require('../clients/eventClient')
const ticketClient = require('../clients/ticketClient')

class IndexingManager {
  constructor () {
    this.lastIndexedTime = null
    this.indexedCounts = {
      events: 0,
      tickets: 0
    }
    this.loadIndexingState()
  }

  // Load previous indexing state from file/DB
  async loadIndexingState () {
    try {
      // Could store in MongoDB or file system
      const fs = require('fs').promises
      const stateFile = './indexing-state.json'

      try {
        const data = await fs.readFile(stateFile, 'utf8')
        const state = JSON.parse(data)
        this.lastIndexedTime = new Date(state.lastIndexedTime)
        this.indexedCounts = state.counts || { events: 0, tickets: 0 }
        console.log('Loaded indexing state:', {
          lastIndexed: this.lastIndexedTime,
          counts: this.indexedCounts
        })
      } catch (fileError) {
        console.log('No previous indexing state found, will do full index')
        this.lastIndexedTime = null
      }
    } catch (error) {
      console.warn('Failed to load indexing state:', error.message)
    }
  }

  // Save indexing state
  async saveIndexingState () {
    try {
      const fs = require('fs').promises
      const stateFile = './indexing-state.json'
      const state = {
        lastIndexedTime: new Date().toISOString(),
        counts: this.indexedCounts
      }
      await fs.writeFile(stateFile, JSON.stringify(state, null, 2))
      console.log('Saved indexing state:', state)
    } catch (error) {
      console.warn('Failed to save indexing state:', error.message)
    }
  }

  // Check if indexing is needed
  async shouldReindex (dataType = null) {
    try {
      // 1. Check vector DB stats
      const vectorStats = await getIndexStats()
      console.log('Vector DB stats:', vectorStats)

      // 2. Get current data counts from services
      const currentCounts = await this.getCurrentDataCounts()
      console.log('Current data counts:', currentCounts)

      // 3. Compare with last indexed counts
      const needsReindex = {
        events: false,
        tickets: false,
        reason: []
      }

      // Check if no vectors exist
      if (vectorStats.totalVectorCount === 0) {
        needsReindex.events = true
        needsReindex.tickets = true
        needsReindex.reason.push('No vectors in database')
        return needsReindex
      }

      // Check if data counts changed
      if (currentCounts.events !== this.indexedCounts.events) {
        needsReindex.events = true
        needsReindex.reason.push(
          `Events count changed: ${this.indexedCounts.events} → ${currentCounts.events}`
        )
      }

      if (currentCounts.tickets !== this.indexedCounts.tickets) {
        needsReindex.tickets = true
        needsReindex.reason.push(
          `Tickets count changed: ${this.indexedCounts.tickets} → ${currentCounts.tickets}`
        )
      }

      // Check time-based reindex (once per day max)
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000)
      if (!this.lastIndexedTime || this.lastIndexedTime < oneDayAgo) {
        needsReindex.events = true
        needsReindex.tickets = true
        needsReindex.reason.push('Time-based reindex (24h+)')
      }

      // Filter by dataType if specified
      if (dataType) {
        const result = { reason: needsReindex.reason }
        result[dataType] = needsReindex[dataType]
        return result
      }

      return needsReindex
    } catch (error) {
      console.error('Error checking reindex needs:', error)
      // Fallback: always reindex on error
      return {
        events: true,
        tickets: true,
        reason: [`Error checking: ${error.message}`]
      }
    }
  }

  async getCurrentDataCounts () {
    const counts = { events: 0, tickets: 0 }

    try {
      const events = await eventClient.getAllEvents()
      counts.events = events?.length || 0
    } catch (error) {
      console.warn('Failed to get events count:', error.message)
    }

    try {
      const tickets = await ticketClient.getAllTickets()
      counts.tickets = tickets?.length || 0
    } catch (error) {
      console.warn('Failed to get tickets count:', error.message)
    }

    return counts
  }

  async updateIndexedCounts (dataType, count) {
    this.indexedCounts[dataType] = count
    this.lastIndexedTime = new Date()
    await this.saveIndexingState()
  }
}

module.exports = new IndexingManager()
