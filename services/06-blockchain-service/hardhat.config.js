require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

const { ETHEREUM_RPC_URL, SIGNER_PRIVATE_KEY, LINEASCAN_API_KEY } = process.env

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: '0.8.28',
  networks: {
    lineaSepolia: {
      url: ETHEREUM_RPC_URL || '',
      accounts: SIGNER_PRIVATE_KEY ? [SIGNER_PRIVATE_KEY] : [],
      chainId: 59141
    }
  },
  // Thêm mục này để cấu hình verify
  etherscan: {
    apiKey: {
      lineaSepolia: LINEASCAN_API_KEY || ''
    },
    customChains: [
      {
        network: 'lineaSepolia',
        chainId: 59141,
        urls: {
          apiURL: 'https://api-sepolia.lineascan.build/api',
          browserURL: 'https://sepolia.lineascan.build'
        }
      }
    ]
  }
}
