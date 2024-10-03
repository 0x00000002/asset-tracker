import TelegramBot from 'node-telegram-bot-api'
import { ethers } from 'ethers'

import {
  SecretsManagerClient,
  GetSecretValueCommand
} from '@aws-sdk/client-secrets-manager'

const secret_name = 'TGBot'

const customRpcUrl = 'https://root.rootnet.live'
const provider = new ethers.JsonRpcProvider(customRpcUrl)

const accounts = ['0xFffFfFff0000000000000000000000000000070B']

const ROOT_TOKEN = '0xcCcCCccC00000001000000000000000000000000'
const ASTO_TOKEN = '0xCccCccCc00001064000000000000000000000000'

const transferEvent = // 'event Transfer(address,address,uint256)'
  'event Transfer(address indexed from, address indexed to, uint256 amount)'

const tokenABI = [
  // 'function balanceOf(address) external view returns (uint256)',
  // 'function transfer(address to, uint256 value) external returns (bool)',
  // 'function transferFrom(address from, address to, uint256 value) external returns (bool)',
  transferEvent
]

const root_ = new ethers.Contract(ROOT_TOKEN, tokenABI, provider)
const asto_ = new ethers.Contract(ASTO_TOKEN, tokenABI, provider)

const contracts = [root_]

// const iface = new ethers.Interface([transferEvent])

let bot
let lastChecked = 0014828917

const initBot = async () => {
  const secret_name = 'tgToken'

  const client = new SecretsManagerClient({
    region: 'us-east-1'
  })

  let response

  try {
    response = await client.send(
      new GetSecretValueCommand({
        SecretId: secret_name,
        VersionStage: 'AWSCURRENT' // VersionStage defaults to AWSCURRENT if unspecified
      })
    )
  } catch (error) {
    // For a list of exceptions thrown, see
    // https://docs.aws.amazon.com/secretsmanager/latest/apireference/API_GetSecretValue.html
    throw error
  }

  const { TelegramBotToken } = JSON.parse(response.SecretString)
  bot = new TelegramBot(TelegramBotToken)
}

const getTransferEvents = async (accounts, fromBlock) => {
  try {
    const allEvents = []
    contracts.forEach(async contract => {
      accounts.forEach(async account => {
        // Define the filter for the Transfer event from the specific account
        console.log({ account, fromBlock }, 'contract:', contract.target)
        const filter = contract.filters.Transfer(account, null)
        // Query the logs from the specified block to the latest block
        const events = await contract.queryFilter(filter, fromBlock, 'latest')
        console.log(events)
        allEvents.push(...events)
      })
    })
    return allEvents
  } catch (error) {
    console.error('Error fetching events:', error)
    return []
  }
}

export const handler = async event => {
  // bot || initBot()

  const currentBlock = await provider.getBlockNumber()

  // if (lastChecked === null) {
  //   lastChecked = currentBlock
  //   return {
  //     statusCode: 200,
  //     body: JSON.stringify('Initial setup complete.')
  //   }
  // }

  const events = await getTransferEvents(accounts, lastChecked)

  let msgs = []

  events.forEach(event => {
    const { from, to, value } = event.returnValues

    if (accountsToMonitor.includes(from) || accountsToMonitor.includes(to)) {
      const message = `Token Transfer:\nFrom: ${from}\nTo: ${to}\nValue: ${web3.utils.fromWei(
        value,
        'ether'
      )}`

      // Send Telegram notification
      bot.sendMessage('YOUR_CHAT_ID', message)
      msgs.push(message)
    }
  })

  lastChecked = currentBlock

  const body = msgs.length ? msgs.join('\n') : 'No new transfers.'

  return {
    statusCode: 200,
    body
  }
}
