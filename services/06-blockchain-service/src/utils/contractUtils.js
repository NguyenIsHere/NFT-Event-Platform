// src/utils/contractUtils.js
const { ethers } = require('ethers')
const path = require('path')
const fs = require('fs')
// Load .env từ thư mục gốc của service (06-blockchain-service/.env)
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') })

const rpcUrl = process.env.ETHEREUM_RPC_URL
const signerPrivateKey = process.env.SIGNER_PRIVATE_KEY
const contractAddress = process.env.EVENT_TICKET_NFT_CONTRACT_ADDRESS

if (!rpcUrl || !signerPrivateKey || !contractAddress) {
  console.error(
    'FATAL ERROR: Ethereum RPC URL, Signer Private Key, or Contract Address is not defined in .env for BlockchainService.'
  )
  process.exit(1)
}

// --- Khởi tạo Provider và Signer ---
const provider = new ethers.JsonRpcProvider(rpcUrl)
const signer = new ethers.Wallet(signerPrivateKey, provider)
console.log(`BlockchainService: Signer address: ${signer.address}`)

// --- Load ABI từ Hardhat artifact ---
let contractABI
try {
  // Đường dẫn này phải trỏ đến file JSON artifact do Hardhat tạo ra sau khi compile
  // Thường là: artifacts/contracts/YourContractName.sol/YourContractName.json
  const abiPath = path.resolve(
    __dirname,
    '..',
    '..',
    'artifacts',
    'contracts',
    'EventTicketNFT.sol',
    'EventTicketNFT.json'
  )
  const artifact = JSON.parse(fs.readFileSync(abiPath, 'utf8'))
  contractABI = artifact.abi
  if (!contractABI || contractABI.length === 0) {
    throw new Error('ABI is empty or not found in artifact.')
  }
  console.log(
    `BlockchainService: Loaded ABI for EventTicketNFT from ${abiPath}`
  )
} catch (error) {
  console.error(
    'FATAL ERROR: Could not load contract ABI from artifact.',
    error
  )
  console.error(
    "Ensure you have compiled your contracts using 'npx hardhat compile' and the artifact path is correct."
  )
  process.exit(1)
}

const eventTicketNFTContract = new ethers.Contract(
  contractAddress,
  contractABI,
  signer
)
console.log(
  `BlockchainService: Connected to EventTicketNFT contract at ${contractAddress}`
)

module.exports = {
  provider,
  signer,
  eventTicketNFTContract,
  ethers
}
