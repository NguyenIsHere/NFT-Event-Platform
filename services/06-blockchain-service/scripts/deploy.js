// scripts/deploy.js
const hre = require('hardhat')
const fs = require('fs')
const path = require('path')

async function main () {
  const [deployer] = await hre.ethers.getSigners()
  console.log('Deploying contracts with the account:', deployer.address)
  console.log(
    'Account balance:',
    (await hre.ethers.provider.getBalance(deployer.address)).toString()
  )

  const EventTicketNFTFactory = await hre.ethers.getContractFactory(
    'EventTicketNFT'
  )
  const eventTicketNFT = await EventTicketNFTFactory.deploy()

  // Chờ contract được deploy hoàn toàn trên các mạng testnet/mainnet
  // Đối với hardhat network (local), nó thường được mined ngay lập tức
  // Sử dụng await eventTicketNFT.waitForDeployment() cho ethers v6
  // Đối với ethers v5, bạn dùng await eventTicketNFT.deployed();
  // Và address sẽ là eventTicketNFT.address
  // Với ethers v6, address là await eventTicketNFT.getAddress() sau khi deploy() được resolve
  const contractAddress = await eventTicketNFT.getAddress()
  console.log('EventTicketNFT contract deployed to:', contractAddress)

  // ----- Lưu địa chỉ contract và ABI -----
  // 1. Lưu địa chỉ vào một file config hoặc .env để service có thể đọc
  // Ví dụ: cập nhật file .env (cần cẩn thận với cách này trong CI/CD)
  // Hoặc tốt hơn là in ra và người dùng tự cập nhật .env
  console.log('\n----------------------------------------------------')
  console.log('ACTION REQUIRED: Update .env file with the following line:')
  console.log(`EVENT_TICKET_NFT_CONTRACT_ADDRESS="${contractAddress}"`)
  console.log('----------------------------------------------------\n')

  // 2. Lưu ABI để service có thể sử dụng
  // Hardhat tự động lưu ABI và bytecode vào thư mục 'artifacts'
  // artifacts/contracts/EventTicketNFT.sol/EventTicketNFT.json
  // Bạn sẽ điều chỉnh contractUtils.js để đọc ABI từ file này.
  const artifact = hre.artifacts.readArtifactSync('EventTicketNFT')
  const artifactsDir = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    'EventTicketNFT.sol'
  )
  if (!fs.existsSync(artifactsDir)) {
    fs.mkdirSync(artifactsDir, { recursive: true })
  }
  fs.writeFileSync(
    path.join(artifactsDir, 'EventTicketNFT.json'), // Đảm bảo tên file và đường dẫn đúng
    JSON.stringify(artifact, null, 2)
  )
  console.log(
    'EventTicketNFT ABI and bytecode artifact saved to artifacts/ directory.'
  )
  console.log(
    "Ensure contractUtils.js reads ABI from 'artifacts/contracts/EventTicketNFT.sol/EventTicketNFT.json'"
  )
}

main()
  .then(() => process.exit(0))
  .catch(error => {
    console.error(error)
    process.exit(1)
  })
