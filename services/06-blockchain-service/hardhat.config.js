require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

module.exports = {
  solidity: '0.8.28',
  networks: {
    lineaSepolia: {
      url: process.env.ETHEREUM_RPC_URL, // Đọc URL từ .env
      accounts: process.env.SIGNER_PRIVATE_KEY
        ? [process.env.SIGNER_PRIVATE_KEY]
        : [] // Mảng chứa private key
    }
  },
  paths: {
    sources: './contracts', // Thư mục chứa contract
    tests: './test' // Thư mục chứa test
  }
}
